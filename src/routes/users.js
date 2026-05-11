import express from "express";
import User from "../models/User.js";
import { authRequired } from "../middleware/auth.js";

const router = express.Router();

router.get("/", authRequired, async (req, res) => {
  try {
    const users = await User.find({ _id: { $ne: req.userId } })
      .select("username email avatarUrl")
      .sort({ username: 1 })
      .lean();
    res.json(
      users.map((u) => ({
        id: u._id.toString(),
        username: u.username,
        email: u.email,
        avatarUrl: u.avatarUrl || "",
      }))
    );
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to list users" });
  }
});

export default router;
