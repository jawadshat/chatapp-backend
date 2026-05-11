import "dotenv/config";
import express from "express";
import http from "http";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import { Server } from "socket.io";
import authRoutes from "./routes/auth.js";
import usersRoutes from "./routes/users.js";
import messagesRoutes from "./routes/messages.js";
import Message from "./models/Message.js";
import { socketAuth } from "./middleware/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 4000;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";
const ALLOWED_ORIGINS = CLIENT_URL.split(",")
  .map((v) => v.trim())
  .filter(Boolean)
  .map((origin) => origin.replace(/\/$/, ""));

function isAllowedOrigin(origin) {
  if (!origin) return true;
  const clean = origin.replace(/\/$/, "");
  return ALLOWED_ORIGINS.includes(clean);
}

if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET is required");
  process.exit(1);
}

const app = express();
app.use(
  cors({
    origin(origin, cb) {
      if (isAllowedOrigin(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  }),
);
app.use(express.json());

const uploadRoot = path.join(__dirname, "../uploads");
app.use("/uploads", express.static(uploadRoot));

app.use("/api/auth", authRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/messages", messagesRoutes);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin(origin, cb) {
      if (isAllowedOrigin(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST"],
    credentials: true,
  },
});

/** userId -> socket id */
const onlineUsers = new Map();

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  const userId = socketAuth(token);
  if (!userId) {
    return next(new Error("Unauthorized"));
  }
  socket.userId = userId;
  next();
});

io.on("connection", async (socket) => {
  const userId = socket.userId;
  onlineUsers.set(userId.toString(), socket.id);
  socket.join(`user:${userId}`);

  socket.emit("online_users", Array.from(onlineUsers.keys()));
  io.emit("presence", { userId: userId.toString(), online: true });

  socket.on("send_message", async ({ recipientId, text }, cb) => {
    try {
      const trimmed = (text || "").trim();
      if (!recipientId || !trimmed) {
        return cb?.({ error: "Invalid message" });
      }
      const msg = await Message.create({
        sender: userId,
        recipient: recipientId,
        text: trimmed,
      });
      const populated = await Message.findById(msg._id)
        .populate("sender", "username avatarUrl")
        .populate("recipient", "username avatarUrl")
        .lean();

      const payload = {
        id: populated._id.toString(),
        text: populated.text,
        createdAt: populated.createdAt,
        reactions: (populated.reactions || []).map((r) => ({
          userId: r.user.toString(),
          emoji: r.emoji,
        })),
        sender: {
          id: populated.sender._id.toString(),
          username: populated.sender.username,
          avatarUrl: populated.sender.avatarUrl || "",
        },
        recipient: {
          id: populated.recipient._id.toString(),
          username: populated.recipient.username,
          avatarUrl: populated.recipient.avatarUrl || "",
        },
      };

      io.to(`user:${userId}`).emit("new_message", payload);
      io.to(`user:${recipientId}`).emit("new_message", payload);
      cb?.({ ok: true });
    } catch (e) {
      console.error(e);
      cb?.({ error: "Failed to send" });
    }
  });

  socket.on("toggle_reaction", async ({ messageId, emoji }, cb) => {
    try {
      const normalized = (emoji || "").trim();
      if (!messageId || !normalized) {
        return cb?.({ error: "Invalid reaction" });
      }

      const msg = await Message.findById(messageId);
      if (!msg) return cb?.({ error: "Message not found" });

      const me = userId.toString();
      const meInThread =
        msg.sender.toString() === me || msg.recipient.toString() === me;
      if (!meInThread) {
        return cb?.({ error: "Forbidden" });
      }

      const existing = msg.reactions.findIndex(
        (r) => r.user.toString() === me && r.emoji === normalized,
      );
      if (existing >= 0) msg.reactions.splice(existing, 1);
      else msg.reactions.push({ user: userId, emoji: normalized });

      await msg.save();
      const refreshed = await Message.findById(msg._id)
        .populate("sender", "username avatarUrl")
        .populate("recipient", "username avatarUrl")
        .lean();
      if (!refreshed) return cb?.({ error: "Message not found" });

      const payload = {
        messageId: refreshed._id.toString(),
        reactions: (refreshed.reactions || []).map((r) => ({
          userId: r.user.toString(),
          emoji: r.emoji,
        })),
      };

      io.to(`user:${refreshed.sender._id.toString()}`).emit(
        "message_reactions",
        payload,
      );
      io.to(`user:${refreshed.recipient._id.toString()}`).emit(
        "message_reactions",
        payload,
      );
      cb?.({ ok: true, ...payload });
    } catch (e) {
      console.error(e);
      cb?.({ error: "Failed to react" });
    }
  });

  socket.on("call_offer", ({ toUserId, offer, isVideo }, cb) => {
    try {
      const target = String(toUserId || "");
      if (!target || !offer) return cb?.({ error: "Invalid call offer" });
      io.to(`user:${target}`).emit("incoming_call", {
        fromUserId: userId.toString(),
        offer,
        isVideo: !!isVideo,
      });
      cb?.({ ok: true });
    } catch (e) {
      console.error(e);
      cb?.({ error: "Failed to send offer" });
    }
  });

  socket.on("call_answer", ({ toUserId, answer }, cb) => {
    try {
      const target = String(toUserId || "");
      if (!target || !answer) return cb?.({ error: "Invalid answer" });
      io.to(`user:${target}`).emit("call_answered", {
        fromUserId: userId.toString(),
        answer,
      });
      cb?.({ ok: true });
    } catch (e) {
      console.error(e);
      cb?.({ error: "Failed to send answer" });
    }
  });

  socket.on("call_ice_candidate", ({ toUserId, candidate }) => {
    try {
      const target = String(toUserId || "");
      if (!target || !candidate) return;
      io.to(`user:${target}`).emit("call_ice_candidate", {
        fromUserId: userId.toString(),
        candidate,
      });
    } catch (e) {
      console.error(e);
    }
  });

  socket.on("call_decline", ({ toUserId }, cb) => {
    try {
      const target = String(toUserId || "");
      if (!target) return cb?.({ error: "Invalid decline target" });
      io.to(`user:${target}`).emit("call_declined", {
        fromUserId: userId.toString(),
      });
      cb?.({ ok: true });
    } catch (e) {
      console.error(e);
      cb?.({ error: "Failed to decline call" });
    }
  });

  socket.on("call_end", ({ toUserId }, cb) => {
    try {
      const target = String(toUserId || "");
      if (!target) return cb?.({ error: "Invalid end target" });
      io.to(`user:${target}`).emit("call_ended", {
        fromUserId: userId.toString(),
      });
      cb?.({ ok: true });
    } catch (e) {
      console.error(e);
      cb?.({ error: "Failed to end call" });
    }
  });

  socket.on("disconnect", () => {
    if (onlineUsers.get(userId.toString()) === socket.id) {
      onlineUsers.delete(userId.toString());
    }
    io.emit("presence", { userId: userId.toString(), online: false });
  });
});

async function start() {
  const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/chatapp";
  await mongoose.connect(uri);
  console.log("MongoDB connected");

  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
