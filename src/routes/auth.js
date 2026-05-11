import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import User from "../models/User.js";
import { authRequired } from "../middleware/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.join(__dirname, "../../uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image files allowed"));
    }
    cb(null, true);
  },
});

function uploadSingle(field) {
  return (req, res, next) => {
    upload.single(field)(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err.message || "Upload failed" });
      }
      next();
    });
  };
}

const router = express.Router();

function signToken(userId) {
  return jwt.sign({ userId: userId.toString() }, process.env.JWT_SECRET, { expiresIn: "7d" });
}

function userResponse(user) {
  return {
    id: user._id.toString(),
    username: user.username,
    email: user.email,
    avatarUrl: user.avatarUrl || "",
  };
}

router.post("/register", uploadSingle("avatar"), async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: "Username, email, and password required" });
    }
    const existing = await User.findOne({ $or: [{ email }, { username }] });
    if (existing) {
      return res.status(400).json({ error: "Email or username already taken" });
    }
    const hash = await bcrypt.hash(password, 10);
    let avatarUrl = "";
    if (req.file) {
      avatarUrl = `/uploads/${req.file.filename}`;
    }
    const user = await User.create({ username, email, password: hash, avatarUrl });
    const token = signToken(user._id);
    res.status(201).json({ token, user: userResponse(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Registration failed" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }
    const user = await User.findOne({ email }).select("+password");
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const token = signToken(user._id);
    res.json({ token, user: userResponse(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Login failed" });
  }
});

router.get("/me", authRequired, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(userResponse(user));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load user" });
  }
});

router.put("/profile", authRequired, uploadSingle("avatar"), async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (req.file) {
      if (user.avatarUrl?.startsWith("/uploads/")) {
        const oldPath = path.join(__dirname, "../..", user.avatarUrl);
        fs.unlink(oldPath, () => {});
      }
      user.avatarUrl = `/uploads/${req.file.filename}`;
    }
    if (req.body.username?.trim()) {
      const taken = await User.findOne({
        username: req.body.username.trim(),
        _id: { $ne: user._id },
      });
      if (taken) return res.status(400).json({ error: "Username taken" });
      user.username = req.body.username.trim();
    }
    await user.save();
    res.json(userResponse(user));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Update failed" });
  }
});

export default router;
