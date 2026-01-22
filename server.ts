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
const io = new Server(httpServer, { cors: { origin: "*" } });
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

// ---------- AUTH ----------
app.post('/api/register', async (req, res) => {
  const { email, username, password } = req.body;
  try {
    const hashed = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { email, username, password: hashed }
    });
    res.json(user);
  } catch {
    res.status(400).json({ error: "User exists" });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(400).json({ error: "Invalid credentials" });
  }
  res.json(user);
});

// ---------- FRIENDS ----------
app.post('/api/friends/add', async (req, res) => {
  const { myId, targetUsername } = req.body;
  const target = await prisma.user.findUnique({ where: { username: targetUsername } });
  if (!target) return res.status(404).json({ error: "NotFound" });

  await prisma.friendRequest.create({
    data: { senderId: myId, receiverId: target.id }
  });

  io.to(target.id).emit('update_friends');
  res.json({ ok: true });
});

app.get('/api/friends/:userId', async (req, res) => {
  const userId = req.params.userId;
  const friends = await prisma.friendRequest.findMany({
    where: { OR: [{ senderId: userId }, { receiverId: userId }] },
    include: { sender: true, receiver: true }
  });
  res.json(friends);
});

// ---------- LIVEKIT TOKEN ----------
app.get('/api/token', (req: Request, res: Response) => {
  const { room, username } = req.query;
  if (!room || !username) return res.status(400).send("Missing params");

  const at = new AccessToken(
    process.env.LIVEKIT_API_KEY!,
    process.env.LIVEKIT_API_SECRET!,
    {
      identity: `${username}_${crypto.randomUUID()}`
    }
  );

  at.addGrant({
    roomJoin: true,
    room: room as string,
    canPublish: true,
    canSubscribe: true,
  });

  res.json({
    token: at.toJwt(),
    url: "wss://talkproject-t32qqp1a.livekit.cloud"
  });
});

// ---------- SOCKET ----------
io.on('connection', (socket: Socket) => {
  socket.on('join_room', (id: string) => socket.join(id));
  socket.on('send_msg', (data) => io.to(data.roomId).emit('new_msg', data));
  socket.on('start_call', (data) => io.to(data.to).emit('incoming_call', data));
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
