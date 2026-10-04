const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const User = require("../models/User");
const { protect } = require("../middleware/auth");
const { wrap, rateLimit, cleanPhone, isValidPhone, cleanEmail, isValidEmail, cleanText } = require("../utils/security");
const email = require("../utils/email");

const router = express.Router();

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60 });
const otpVerifyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

function generateToken(user) {
  return jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: "30d" });
}
function publicUser(user) {
  return { id: user._id, name: user.name, phone: user.phone, email: user.email, role: user.role };
}
function validPassword(password) {
  return typeof password === "string" && password.length >= 6 && password.length <= 64;
}

// ---------- OTP store (in-memory) ----------
const otpStore = new Map();
const otpCooldown = new Map();
const OTP_COOLDOWN_MS = 45 * 1000;
const OTP_MAX_PER_DAY = 5;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

function hashCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}
function generateCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function checkOtpCooldown(key) {
  const now = Date.now();
  const entry = otpCooldown.get(key);
  if (!entry || now - entry.dayStart > 24 * 3600 * 1000) {
    otpCooldown.set(key, { nextAt: now + OTP_COOLDOWN_MS, count: 1, dayStart: now });
    return null;
  }
  if (now < entry.nextAt) {
    return `Please wait ${Math.ceil((entry.nextAt - now) / 1000)} seconds before requesting another code`;
  }
  if (entry.count >= OTP_MAX_PER_DAY) {
    return "Too many codes requested for this email today. Please try again tomorrow.";
  }
  entry.count++;
  entry.nextAt = now + OTP_COOLDOWN_MS;
  return null;
}

function signOtpToken(emailAddr, purpose) {
  return jwt.sign({ email: emailAddr, purpose, otp: true }, process.env.JWT_SECRET, { expiresIn: "10m" });
}
function readOtpToken(token, emailAddr, purpose) {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return decoded.otp === true && decoded.email === emailAddr && decoded.purpose === purpose;
  } catch (e) {
    return false;
  }
}

router.post("/send-otp", authLimiter, wrap(async (req, res) => {
  const emailAddr = cleanEmail(req.body.email);
  const purpose = req.body.purpose;
  if (!isValidEmail(emailAddr)) return res.status(400).json({ message: "Enter a valid email address" });
  if (purpose !== "signup" && purpose !== "reset") return res.status(400).json({ message: "Invalid request" });

  const existing = await User.findOne({ email: emailAddr });
  if (purpose === "signup" && existing) {
    return res.status(400).json({ message: "An account with this email already exists" });
  }
  if (purpose === "reset" && !existing) {
    return res.status(400).json({ message: "No account found with this email" });
  }

  const cooldownMsg = checkOtpCooldown(emailAddr);
  if (cooldownMsg) return res.status(429).json({ message: cooldownMsg });

  const code = generateCode();
  otpStore.set(`${emailAddr}:${purpose}`, { codeHash: hashCode(code), expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 });

  try {
    await email.sendOtpEmail(emailAddr, code);
  } catch (err) {
    return res.status(502).json({ message: err.message });
  }

  res.json({ message: "A code has been sent to your email" });
}));

router.post("/resend-otp", authLimiter, wrap(async (req, res) => {
  const emailAddr = cleanEmail(req.body.email);
  const purpose = req.body.purpose;
  if (!isValidEmail(emailAddr)) return res.status(400).json({ message: "Enter a valid email address" });
  if (purpose !== "signup" && purpose !== "reset") return res.status(400).json({ message: "Invalid request" });

  const cooldownMsg = checkOtpCooldown(emailAddr);
  if (cooldownMsg) return res.status(429).json({ message: cooldownMsg });

  const code = generateCode();
  otpStore.set(`${emailAddr}:${purpose}`, { codeHash: hashCode(code), expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 });

  try {
    await email.sendOtpEmail(emailAddr, code);
  } catch (err) {
    return res.status(502).json({ message: err.message });
  }

  res.json({ message: "A new code has been sent" });
}));

router.post("/verify-otp", otpVerifyLimiter, wrap(async (req, res) => {
  const emailAddr = cleanEmail(req.body.email);
  const code = cleanText(req.body.otp, 10);
  const purpose = req.body.purpose;
  if (!isValidEmail(emailAddr) || !code) return res.status(400).json({ message: "Enter the code you received" });
  if (purpose !== "signup" && purpose !== "reset") return res.status(400).json({ message: "Invalid request" });

  const key = `${emailAddr}:${purpose}`;
  const entry = otpStore.get(key);
  if (!entry || entry.expiresAt < Date.now()) {
    otpStore.delete(key);
    return res.status(400).json({ message: "Incorrect or expired code" });
  }
  if (entry.attempts >= OTP_MAX_ATTEMPTS) {
    otpStore.delete(key);
    return res.status(400).json({ message: "Too many incorrect attempts. Please request a new code." });
  }
  if (hashCode(code) !== entry.codeHash) {
    entry.attempts++;
    return res.status(400).json({ message: "Incorrect or expired code" });
  }

  otpStore.delete(key);
  res.json({ verified: true, otpToken: signOtpToken(emailAddr, purpose) });
}));

router.post("/signup", authLimiter, wrap(async (req, res) => {
  const name = cleanText(req.body.name, 50);
  const phone = cleanPhone(req.body.phone);
  const emailAddr = cleanEmail(req.body.email);
  const { password, role, otpToken } = req.body;

  if (name.length < 2) return res.status(400).json({ message: "Please enter your full name (at least 2 letters)" });
  if (!isValidPhone(phone)) return res.status(400).json({ message: "Enter a valid 10-digit mobile number" });
  if (!isValidEmail(emailAddr)) return res.status(400).json({ message: "Enter a valid email address" });
  if (!validPassword(password)) return res.status(400).json({ message: "Password must be at least 6 characters" });
  if (role !== "customer" && role !== "owner") return res.status(400).json({ message: "Invalid role" });
  if (!readOtpToken(otpToken, emailAddr, "signup")) {
    return res.status(400).json({ message: "Please verify your email again" });
  }

  const existingPhone = await User.findOne({ phone });
  if (existingPhone) return res.status(400).json({ message: "An account with this phone number already exists" });
  const existingEmail = await User.findOne({ email: emailAddr });
  if (existingEmail) return res.status(400).json({ message: "An account with this email already exists" });

  const hashedPassword = await bcrypt.hash(password, 10);
  let user;
  try {
    user = await User.create({ name, phone, email: emailAddr, password: hashedPassword, role, emailVerified: true });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ message: "An account with this phone number or email already exists" });
    throw err;
  }

  res.status(201).json({ token: generateToken(user), user: publicUser(user) });
}));

router.post("/login", authLimiter, wrap(async (req, res) => {
  const phone = cleanPhone(req.body.phone);
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const wrongMsg = "Incorrect phone number or password";

  if (!isValidPhone(phone) || !password) return res.status(400).json({ message: wrongMsg });

  const user = await User.findOne({ phone });
  if (!user) return res.status(400).json({ message: wrongMsg });

  if (user.lockUntil && user.lockUntil > new Date()) {
    const mins = Math.ceil((user.lockUntil - new Date()) / 60000);
    return res.status(429).json({ message: `Too many failed attempts. Try again in ${mins} minutes.` });
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

router.post("/reset-password", authLimiter, wrap(async (req, res) => {
  const emailAddr = cleanEmail(req.body.email);
  const { newPassword, otpToken } = req.body;

  if (!isValidEmail(emailAddr)) return res.status(400).json({ message: "Enter a valid email address" });
  if (!validPassword(newPassword)) return res.status(400).json({ message: "Password must be at least 6 characters" });
  if (!readOtpToken(otpToken, emailAddr, "reset")) {
    return res.status(400).json({ message: "Please verify your email again" });
  }

  const user = await User.findOne({ email: emailAddr });
  if (!user) return res.status(404).json({ message: "No account found with this email" });

  user.password = await bcrypt.hash(newPassword, 10);
  user.failedLogins = 0;
  user.lockUntil = undefined;
  await user.save();

  res.json({ token: generateToken(user), user: publicUser(user), message: "Password reset successfully" });
}));

router.patch("/me", protect, wrap(async (req, res) => {
  const name = cleanText(req.body.name, 50);
  if (name.length < 2) return res.status(400).json({ message: "Name must be at least 2 letters" });
  const user = await User.findByIdAndUpdate(req.user.id, { name }, { new: true });
  if (!user) return res.status(404).json({ message: "User not found" });
  res.json({ user: publicUser(user) });
}));

router.post("/change-password", protect, authLimiter, wrap(async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!validPassword(newPassword)) return res.status(400).json({ message: "New password must be at least 6 characters" });

  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ message: "User not found" });

  const ok = typeof oldPassword === "string" && (await bcrypt.compare(oldPassword, user.password));
  if (!ok) return res.status(400).json({ message: "Old password is incorrect" });

  user.password = await bcrypt.hash(newPassword, 10);
  await user.save();
  res.json({ message: "Password changed" });
}));

module.exports = router;
