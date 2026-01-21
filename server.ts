import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { AccessToken } from 'livekit-server-sdk';
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

// Регистрация
app.post('/api/register', async (req, res) => {
  const { email, username, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({ data: { email, username, password: hashedPassword } });
    res.json(user);
  } catch (e) { res.status(400).json({ error: "User exists" }); }
});

// Логин
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !await bcrypt.compare(password, user.password)) {
        return res.status(400).json({ error: "Fail" });
    }
    res.json(user);
  } catch (e) { res.status(500).json({ error: "Error" }); }
});

// Друзья
app.post('/api/friends/add', async (req, res) => {
    const { myId, targetUsername } = req.body;
    try {
        const target = await prisma.user.findUnique({ where: { username: targetUsername } });
        if (!target) return res.status(404).json({ error: "Not found" });
        const request = await prisma.friendRequest.create({ data: { senderId: myId, receiverId: target.id } });
        io.to(target.id).emit('update_friends');
        res.json(request);
    } catch (e) { res.status(400).json({ error: "Already sent" }); }
});

app.get('/api/friends/:userId', async (req, res) => {
    const f = await prisma.friendRequest.findMany({
        where: { OR: [{ receiverId: req.params.userId }, { senderId: req.params.userId }] },
        include: { sender: true, receiver: true }
    });
    res.json(f);
});

// Сообщения
app.get('/api/messages/:roomId', async (req, res) => {
    const msgs = await prisma.message.findMany({ where: { roomId: req.params.roomId }, orderBy: { createdAt: 'asc' } });
    res.json(msgs);
});

// LiveKit Токен (для звонков)
app.get('/api/token', async (req, res) => {
  const { room, username } = req.query;
  try {
    const at = new AccessToken(
        process.env.LIVEKIT_API_KEY || "API6NzD2nknoFKy", 
        process.env.LIVEKIT_API_SECRET || "b0HExmpk48kfHhpw598dacKTfXiZRf2hiB3NVl6FJOlB", 
        { identity: `${username}_${Date.now()}` }
    );
    at.addGrant({ roomJoin: true, room: room as string, canPublish: true, canSubscribe: true });
    res.send({ token: await at.toJwt() });
  } catch (e) { res.status(500).send("LK Error"); }
});

// Сокеты
io.on('connection', (socket) => {
    socket.on('join_room', (id) => socket.join(id));
    socket.on('send_msg', async (data) => {
        const newMessage = await prisma.message.create({ 
            data: { content: data.content, roomId: data.roomId, userId: data.userId, username: data.username } 
        });
        io.to(data.roomId).emit('new_msg', newMessage);
    });
    socket.on('start_call', (data) => {
        io.to(data.to).emit('incoming_call', data);
    });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => console.log(`✅ Server live on port ${PORT}`));