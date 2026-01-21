import express, { Request, Response } from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { AccessToken } from 'livekit-server-sdk';
import bcrypt from 'bcryptjs';
import * as dotenv from 'dotenv';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { 
    cors: { origin: "*" } // Важно для Electron
});
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

// --- РЕГИСТРАЦИЯ И ЛОГИН ---
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
        const request = await prisma.friendRequest.create({ data: { senderId: myId, receiverId: target.id as string } });
        io.to(target.id).emit('update_friends');
        res.json(request);
    } catch (e) { res.status(400).json({ error: "Error" }); }
});

app.get('/api/friends/:userId', async (req: Request, res: Response) => {
    const userId = req.params.userId as string;
    try {
        const f = await prisma.friendRequest.findMany({
            where: { OR: [{ receiverId: userId }, { senderId: userId }] },
            include: { sender: true, receiver: true }
        });
        res.json(f);
    } catch (e) { res.status(500).json([]); }
});

app.get('/api/messages/:roomId', async (req: Request, res: Response) => {
    const roomId = req.params.roomId as string;
    try {
        const msgs = await prisma.message.findMany({ where: { roomId: roomId }, orderBy: { createdAt: 'asc' } });
        res.json(msgs);
    } catch (e) { res.json([]); }
});

// --- LIVEKIT (ЗВОНКИ) ---
app.get('/api/token', async (req: Request, res: Response) => {
  const { room, username } = req.query;
  try {
    const at = new AccessToken("API6NzD2nknoFKy", "b0HExmpk48kfHhpw598dacKTfXiZRf2hiB3NVl6FJOlB", {
      identity: `${username}_${Date.now()}`, // ГАРАНТИЯ СТАБИЛЬНОСТИ: Уникальный ID сессии
    });
    at.addGrant({ roomJoin: true, room: room as string, canPublish: true, canSubscribe: true });
    res.send({ token: await at.toJwt() });
  } catch (e) { res.status(500).send("LK Error"); }
});

// --- СОКЕТЫ (ЧАТ) ---
io.on('connection', (socket: Socket) => {
    socket.on('join_room', (id: string) => socket.join(id));
    socket.on('send_msg', async (data: any) => {
        try {
            const newMessage = await prisma.message.create({ 
                data: { content: data.content, roomId: data.roomId as string, userId: data.userId as string, username: data.username as string } 
            });
            io.to(data.roomId).emit('new_msg', newMessage);
        } catch (e) {}
    });
    socket.on('start_call', (data: any) => { io.to(data.to).emit('incoming_call', data); });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => console.log(`✅ Talk Server Live on ${PORT}`));