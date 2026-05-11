import express from "express";
import mongoose from "mongoose";
import Message from "../models/Message.js";
import { authRequired } from "../middleware/auth.js";

const router = express.Router();

router.get("/:partnerId", authRequired, async (req, res) => {
  try {
    const { partnerId } = req.params;
    if (!mongoose.isValidObjectId(partnerId)) {
      return res.status(400).json({ error: "Invalid user id" });
    }
    const me = new mongoose.Types.ObjectId(req.userId);
    const other = new mongoose.Types.ObjectId(partnerId);
    const messages = await Message.find({
      $or: [
        { sender: me, recipient: other },
        { sender: other, recipient: me },
      ],
    })
      .sort({ createdAt: 1 })
      .populate("sender", "username avatarUrl")
      .populate("recipient", "username avatarUrl")
      .lean();

    res.json(
      messages.map((m) => ({
        id: m._id.toString(),
        text: m.text,
        createdAt: m.createdAt,
        reactions: (m.reactions || []).map((r) => ({
          userId: r.user.toString(),
          emoji: r.emoji,
        })),
        sender: {
          id: m.sender._id.toString(),
          username: m.sender.username,
          avatarUrl: m.sender.avatarUrl || "",
        },
        recipient: {
          id: m.recipient._id.toString(),
          username: m.recipient.username,
          avatarUrl: m.recipient.avatarUrl || "",
        },
      }))
    );
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load messages" });
  }
});

export default router;
