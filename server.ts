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
const io = new Server(httpServer, { cors: { origin: "*" } });
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

const APP_ID = "1139edf16962412ea299c3da91c89dd1";
const APP_CERTIFICATE = "c2647f769cae463c9bcb14a6b7bf3def";

app.get('/api/token', async (req: Request, res: Response) => {
  const { room } = req.query;
  if (!room) return res.status(400).send("Room required");

  const channelName = room as string;
  // ИСПОЛЬЗУЕМ БЕЗОПАСНЫЙ UID ДЛЯ AGORA
  const uid = Math.floor(Math.random() * 10000); 
  const privilegeExpiredTs = Math.floor(Date.now() / 1000) + 3600;

  try {
    const token = RtcTokenBuilder.buildTokenWithUid(
      APP_ID, APP_CERTIFICATE, channelName, uid, RtcRole.PUBLISHER, privilegeExpiredTs, privilegeExpiredTs
    );
    res.json({ token, uid, appId: APP_ID });
  } catch (e) { res.status(500).send("Error"); }
});

// --- Auth & Friends (Без изменений) ---
app.post('/api/register', async (req, res) => {
  const { email, username, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({ data: { email, username, password: hashedPassword } });
    res.json(user);
  } catch (e) { res.status(400).json({ error: "exists" }); }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !await bcrypt.compare(password, user.password)) return res.status(400).json({ error: "fail" });
  res.json(user);
});

app.post('/api/friends/add', async (req, res) => {
    const { myId, targetUsername } = req.body;
    try {
        const target = await prisma.user.findUnique({ where: { username: targetUsername } });
        if (!target) return res.status(404).json({ error: "notfound" });
        await prisma.friendRequest.create({ data: { senderId: myId, receiverId: target.id } });
        io.to(target.id).emit('update_friends');
        res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: "error" }); }
});

app.get('/api/friends/:userId', async (req, res) => {
    const userId = req.params.userId as string;
    const f = await prisma.friendRequest.findMany({
        where: { OR: [{ receiverId: userId }, { senderId: userId }] },
        include: { sender: true, receiver: true }
    });
    res.json(f);
});

app.get('/api/messages/:roomId', async (req, res) => {
    const roomId = req.params.roomId as string;
    const msgs = await prisma.message.findMany({ where: { roomId }, orderBy: { createdAt: 'asc' } });
    res.json(msgs);
});

io.on('connection', (socket: Socket) => {
    socket.on('join_room', (id: string) => socket.join(id));
    socket.on('send_msg', async (data: any) => {
        try {
            await prisma.message.create({ data: { content: data.content, roomId: data.roomId, userId: data.userId, username: data.username } });
            io.to(data.roomId).emit('new_msg', data);
        } catch (e) {}
    });
    socket.on('start_call', (data: any) => { io.to(data.to).emit('incoming_call', data); });
});

httpServer.listen(3001, () => console.log("✅ Server: 3001"));