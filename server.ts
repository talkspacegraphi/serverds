import express, { Request, Response } from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { RtcTokenBuilder, RtcRole } from 'agora-token';
import bcrypt from 'bcryptjs';
import * as dotenv from 'dotenv';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { 
    cors: { origin: "*" } 
});
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

// ТВОИ КЛЮЧИ AGORA
const APP_ID = "1139edf16962412ea299c3da91c89dd1";
const APP_CERTIFICATE = "c2647f769cae463c9bcb14a6b7bf3def";

// Генерация токена для звонка (БЕЗ ВПН)
// В server.ts замени роут /api/token на этот:
app.get('/api/token', async (req: Request, res: Response) => {
  const { room, userId } = req.query; // Берем userId из запроса
  if (!room || !userId) return res.status(400).send("Missing params");

  const channelName = room as string;
  // Agora требует числовой UID, мы превратим строковый ID из Монго в число
  const uid = Math.abs(userId.toString().split('').reduce((a,b)=>{a=((a<<5)-a)+b.charCodeAt(0);return a&a},0)) % 1000000;
  
  const privilegeExpiredTs = Math.floor(Date.now() / 1000) + 3600;

  try {
    const token = RtcTokenBuilder.buildTokenWithUid(
      APP_ID, APP_CERTIFICATE, channelName, uid, RtcRole.PUBLISHER, privilegeExpiredTs, privilegeExpiredTs
    );
    res.json({ token, uid, appId: APP_ID });
  } catch (e) { res.status(500).send("Error"); }
});

// --- АВТОРИЗАЦИЯ ---
app.post('/api/register', async (req: Request, res: Response) => {
  const { email, username, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({ data: { email, username, password: hashedPassword } });
    res.json(user);
  } catch (e) { res.status(400).json({ error: "User exists" }); }
});

app.post('/api/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !await bcrypt.compare(password, user.password)) return res.status(400).json({ error: "Fail" });
    res.json(user);
  } catch (e) { res.status(500).json({ error: "Error" }); }
});

// --- ДРУЗЬЯ И СООБЩЕНИЯ ---
app.post('/api/friends/add', async (req: Request, res: Response) => {
    const { myId, targetUsername } = req.body;
    try {
        const target = await prisma.user.findUnique({ where: { username: targetUsername } });
        if (!target) return res.status(404).json({ error: "NotFound" });
        const request = await prisma.friendRequest.create({ data: { senderId: myId, receiverId: target.id } });
        io.to(target.id).emit('update_friends');
        res.json(request);
    } catch (e) { res.status(400).json({ error: "Error" }); }
});

app.get('/api/friends/:userId', async (req: Request, res: Response) => {
    const userId = req.params.userId as string;
    const f = await prisma.friendRequest.findMany({
        where: { OR: [{ receiverId: userId }, { senderId: userId }] },
        include: { sender: true, receiver: true }
    });
    res.json(f);
});

app.get('/api/messages/:roomId', async (req: Request, res: Response) => {
    const roomId = req.params.roomId as string;
    const msgs = await prisma.message.findMany({ where: { roomId }, orderBy: { createdAt: 'asc' } });
    res.json(msgs);
});

// --- REAL-TIME (SOCKET.IO) ---
io.on('connection', (socket: Socket) => {
    socket.on('join_room', (id: string) => socket.join(id));

    // Синхронизация ников в звонке
    socket.on('agora_join', (data) => {
        io.to(data.roomId).emit('user_name_info', { uid: data.uid, username: data.username });
    });

    socket.on('send_msg', async (data: any) => {
        try {
            await prisma.message.create({ 
                data: { content: data.content, roomId: data.roomId, userId: data.userId, username: data.username } 
            });
            io.to(data.roomId).emit('new_msg', data);
        } catch (e) {}
    });

    socket.on('start_call', (data: any) => {
        io.to(data.to).emit('incoming_call', data);
    });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => console.log(`✅ Talk Server Running`));