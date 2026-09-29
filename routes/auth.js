const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const { protect } = require("../middleware/auth");
const { wrap, rateLimit, cleanPhone, isValidPhone, cleanText } = require("../utils/security");

const router = express.Router();

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

// Max 60 auth requests per IP per 15 minutes (many phones can share one IP, so not too tight)
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60 });

function generateToken(user) {
  return jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: "30d" });
}
function publicUser(user) {
  return { id: user._id, name: user.name, phone: user.phone, role: user.role };
}
function validPassword(password) {
  return typeof password === "string" && password.length >= 6 && password.length <= 64;
}

// SIGNUP - phone number + password
router.post("/signup", authLimiter, wrap(async (req, res) => {
  const name = cleanText(req.body.name, 50);
  const phone = cleanPhone(req.body.phone);
  const { password, role } = req.body;

  if (name.length < 2) return res.status(400).json({ message: "Apna poora naam likhein (kam se kam 2 letters)" });
  if (!isValidPhone(phone)) return res.status(400).json({ message: "Sahi 10-digit mobile number daalein" });
  if (!validPassword(password)) return res.status(400).json({ message: "Password kam se kam 6 characters ka hona chahiye" });
  if (role !== "customer" && role !== "owner") return res.status(400).json({ message: "Invalid role" });

  const existing = await User.findOne({ phone });
  if (existing) return res.status(400).json({ message: "An account with this phone number already exists" });

  const hashedPassword = await bcrypt.hash(password, 10);
  let user;
  try {
    user = await User.create({ name, phone, password: hashedPassword, role });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ message: "An account with this phone number already exists" });
    throw err;
  }

  res.status(201).json({ token: generateToken(user), user: publicUser(user) });
}));

// LOGIN - phone number + password (locks for 15 min after 5 wrong passwords)
router.post("/login", authLimiter, wrap(async (req, res) => {
  const phone = cleanPhone(req.body.phone);
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const wrongMsg = "Incorrect phone number or password";

  if (!isValidPhone(phone) || !password) return res.status(400).json({ message: wrongMsg });

  const user = await User.findOne({ phone });
  if (!user) return res.status(400).json({ message: wrongMsg });

  if (user.lockUntil && user.lockUntil > new Date()) {
    const mins = Math.ceil((user.lockUntil - new Date()) / 60000);
    return res.status(429).json({ message: `Bahut zyada galat koshish. ${mins} minute baad dobara try karein.` });
  }

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    user.failedLogins = (user.failedLogins || 0) + 1;
    if (user.failedLogins >= MAX_FAILED_LOGINS) {
      user.lockUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
      user.failedLogins = 0;
    }
    await user.save();
    return res.status(400).json({ message: wrongMsg });
  }

  if (user.failedLogins || user.lockUntil) {
    user.failedLogins = 0;
    user.lockUntil = undefined;
    await user.save();
  }
  res.json({ token: generateToken(user), user: publicUser(user) });
}));

// PROFILE: edit name
router.patch("/me", protect, wrap(async (req, res) => {
  const name = cleanText(req.body.name, 50);
  if (name.length < 2) return res.status(400).json({ message: "Naam kam se kam 2 letters ka hona chahiye" });
  const user = await User.findByIdAndUpdate(req.user.id, { name }, { new: true });
  if (!user) return res.status(404).json({ message: "User not found" });
  res.json({ user: publicUser(user) });
}));

// PROFILE: change password
router.post("/change-password", protect, authLimiter, wrap(async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!validPassword(newPassword)) return res.status(400).json({ message: "Naya password kam se kam 6 characters ka hona chahiye" });

  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ message: "User not found" });

  const ok = typeof oldPassword === "string" && (await bcrypt.compare(oldPassword, user.password));
  if (!ok) return res.status(400).json({ message: "Purana password galat hai" });

  user.password = await bcrypt.hash(newPassword, 10);
  await user.save();
  res.json({ message: "Password badal gaya" });
}));

module.exports = router;
