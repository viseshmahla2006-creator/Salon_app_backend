// Dhun music app — email + password accounts with Brevo email-OTP verification.
// Mounted at /api/dhun. Reuses the SalonWale Brevo pipeline (utils/email),
// security helpers, and JWT_SECRET. Dhun users live in their own collection.
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const DhunUser = require("../models/DhunUser");
const { protect } = require("../middleware/auth");
const { wrap, rateLimit, cleanEmail, isValidEmail, cleanText } = require("../utils/security");
const email = require("../utils/email");

const router = express.Router();

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60 });
const otpVerifyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

function generateToken(user) {
  return jwt.sign({ id: user._id, app: "dhun" }, process.env.JWT_SECRET, { expiresIn: "30d" });
}
function publicUser(user) {
  return { id: user._id, email: user.email, name: user.name || "" };
}
function validPassword(password) {
  return typeof password === "string" && password.length >= 6 && password.length <= 64;
}

// ---------- OTP store (in-memory) ----------
const otpStore = new Map(); // email -> { codeHash, expiresAt, attempts }
const otpCooldown = new Map(); // email -> { nextAt, count, dayStart }
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
function signOtpToken(emailAddr) {
  return jwt.sign({ email: emailAddr, purpose: "dhun-signup", otp: true }, process.env.JWT_SECRET, { expiresIn: "10m" });
}
function readOtpToken(token, emailAddr) {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return decoded.otp === true && decoded.email === emailAddr && decoded.purpose === "dhun-signup";
  } catch (e) {
    return false;
  }
}

// SEND OTP for signup (email must not already have an account)
router.post("/send-otp", authLimiter, wrap(async (req, res) => {
  const emailAddr = cleanEmail(req.body.email);
  if (!isValidEmail(emailAddr)) return res.status(400).json({ message: "Enter a valid email address" });

  const existing = await DhunUser.findOne({ email: emailAddr });
  if (existing) return res.status(400).json({ message: "An account with this email already exists. Please log in." });

  const cooldownMsg = checkOtpCooldown(emailAddr);
  if (cooldownMsg) return res.status(429).json({ message: cooldownMsg });

  const code = generateCode();
  otpStore.set(emailAddr, { codeHash: hashCode(code), expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 });

  try {
    await email.sendOtpEmail(emailAddr, code, "SONIQ");
  } catch (err) {
    return res.status(502).json({ message: err.message });
  }
  res.json({ message: "A code has been sent to your email" });
}));

// VERIFY OTP -> returns short-lived otpToken for /signup
router.post("/verify-otp", otpVerifyLimiter, wrap(async (req, res) => {
  const emailAddr = cleanEmail(req.body.email);
  const code = cleanText(req.body.otp, 10);
  if (!isValidEmail(emailAddr) || !code) return res.status(400).json({ message: "Enter the code you received" });

  const entry = otpStore.get(emailAddr);
  if (!entry || entry.expiresAt < Date.now()) {
    otpStore.delete(emailAddr);
    return res.status(400).json({ message: "Incorrect or expired code" });
  }
  if (entry.attempts >= OTP_MAX_ATTEMPTS) {
    otpStore.delete(emailAddr);
    return res.status(400).json({ message: "Too many incorrect attempts. Please request a new code." });
  }
  if (hashCode(code) !== entry.codeHash) {
    entry.attempts++;
    return res.status(400).json({ message: "Incorrect or expired code" });
  }
  otpStore.delete(emailAddr);
  res.json({ verified: true, otpToken: signOtpToken(emailAddr) });
}));

// SIGNUP - email + password, email must be OTP-verified first
router.post("/signup", authLimiter, wrap(async (req, res) => {
  const emailAddr = cleanEmail(req.body.email);
  const { password, otpToken } = req.body;
  if (!isValidEmail(emailAddr)) return res.status(400).json({ message: "Enter a valid email address" });
  if (!validPassword(password)) return res.status(400).json({ message: "Password must be at least 6 characters" });
  if (!readOtpToken(otpToken, emailAddr)) {
    return res.status(400).json({ message: "Please verify your email again" });
  }

  const existing = await DhunUser.findOne({ email: emailAddr });
  if (existing) return res.status(400).json({ message: "An account with this email already exists. Please log in." });

  const hashedPassword = await bcrypt.hash(password, 10);
  const displayName = typeof req.body.name === "string" ? req.body.name.trim().slice(0, 60) : "";
  let user;
  try {
    user = await DhunUser.create({ email: emailAddr, password: hashedPassword, emailVerified: true, name: displayName });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ message: "An account with this email already exists. Please log in." });
    throw err;
  }
  res.status(201).json({ token: generateToken(user), user: publicUser(user) });
}));

// LOGIN - email + password (locks for 15 min after 5 wrong passwords)
router.post("/login", authLimiter, wrap(async (req, res) => {
  const emailAddr = cleanEmail(req.body.email);
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const wrongMsg = "Incorrect email or password";

  if (!isValidEmail(emailAddr) || !password) return res.status(400).json({ message: wrongMsg });

  const user = await DhunUser.findOne({ email: emailAddr });
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
  }
  // login tracking for the owner's admin view
  user.lastLoginAt = new Date();
  user.loginCount = (user.loginCount || 0) + 1;
  await user.save();
  res.json({ token: generateToken(user), user: publicUser(user) });
}));

// ---------- Password reset ----------
const resetStore = new Map(); // email -> { codeHash, expiresAt, attempts }

// SEND reset code (only if the account exists; same reply either way
// PROFILE - get/update display name (v2.43)
router.get("/profile", protect, wrap(async (req, res) => {
  const user = await DhunUser.findById(req.user.id).select("name email");
  if (!user) return res.status(404).json({ message: "User not found" });
  res.json({ name: user.name || "", email: user.email });
}));
router.post("/profile", protect, wrap(async (req, res) => {
  const displayName = typeof req.body.name === "string" ? req.body.name.trim().slice(0, 60) : "";
  if (!displayName) return res.status(400).json({ message: "Name is required" });
  const user = await DhunUser.findByIdAndUpdate(req.user.id, { name: displayName }, { new: true }).select("name email");
  if (!user) return res.status(404).json({ message: "User not found" });
  res.json({ name: user.name || "", email: user.email });
}));

// so the endpoint doesn't reveal which emails are registered)
router.post("/forgot-password", authLimiter, wrap(async (req, res) => {
  const emailAddr = cleanEmail(req.body.email);
  if (!isValidEmail(emailAddr)) return res.status(400).json({ message: "Enter a valid email address" });

  const user = await DhunUser.findOne({ email: emailAddr });
  if (user) {
    const cooldownMsg = checkOtpCooldown(emailAddr);
    if (cooldownMsg) return res.status(429).json({ message: cooldownMsg });

    const code = generateCode();
    resetStore.set(emailAddr, { codeHash: hashCode(code), expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 });
    try {
      await email.sendOtpEmail(emailAddr, code, "SONIQ");
    } catch (err) {
      return res.status(502).json({ message: err.message });
    }
  }
  res.json({ message: "If an account exists for this email, a reset code has been sent" });
}));

// RESET password with the emailed code
router.post("/reset-password", otpVerifyLimiter, wrap(async (req, res) => {
  const emailAddr = cleanEmail(req.body.email);
  const code = cleanText(req.body.otp, 10);
  const password = req.body.password;
  if (!isValidEmail(emailAddr) || !code) return res.status(400).json({ message: "Enter the code you received" });
  if (!validPassword(password)) return res.status(400).json({ message: "Password must be at least 6 characters" });

  const entry = resetStore.get(emailAddr);
  if (!entry || entry.expiresAt < Date.now()) {
    resetStore.delete(emailAddr);
    return res.status(400).json({ message: "Incorrect or expired code" });
  }
  if (entry.attempts >= OTP_MAX_ATTEMPTS) {
    resetStore.delete(emailAddr);
    return res.status(400).json({ message: "Too many incorrect attempts. Please request a new code." });
  }
  if (hashCode(code) !== entry.codeHash) {
    entry.attempts++;
    return res.status(400).json({ message: "Incorrect or expired code" });
  }
  resetStore.delete(emailAddr);

  const user = await DhunUser.findOne({ email: emailAddr });
  if (!user) return res.status(400).json({ message: "Incorrect or expired code" });
  user.password = await bcrypt.hash(password, 10);
  user.failedLogins = 0;
  user.lockUntil = undefined;
  await user.save();
  res.json({ ok: true, message: "Password updated. Please log in with your new password." });
}));

// ---------- Owner admin view ----------
// Who has signed up / logged in. Guarded by DHUN_ADMIN_KEY (Render env var),
// so it stays out of the app itself — the owner asks Muse, Muse checks.
router.get("/admin/users", wrap(async (req, res) => {
  const adminKey = process.env.DHUN_ADMIN_KEY;
  if (!adminKey || req.query.key !== adminKey) {
    return res.status(403).json({ message: "Forbidden" });
  }
  const users = await DhunUser.find({})
    .select("email createdAt lastLoginAt loginCount emailVerified")
    .sort({ createdAt: -1 })
    .lean();
  res.json({
    count: users.length,
    users: users.map(u => ({
      email: u.email,
      signedUp: u.createdAt,
      lastLogin: u.lastLoginAt || null,
      logins: u.loginCount || 0,
      verified: !!u.emailVerified,
    })),
  });
}));

// ME - validate session
router.get("/me", protect, wrap(async (req, res) => {
  if (req.user.app !== "dhun") return res.status(401).json({ message: "Invalid token" });
  const user = await DhunUser.findById(req.user.id);
  if (!user) return res.status(404).json({ message: "User not found" });
  res.json({ user: publicUser(user) });
}));

// ---------- Cloud sync ----------
// The app keeps liked songs + recents locally; these endpoints let the same
// account carry them across devices. Full-replace semantics: the client sends
// its merged lists, the server stores them. Sizes are capped.

function cleanSong(s) {
  if (!s || typeof s !== "object") return null;
  const videoId = cleanText(s.videoId, 40);
  if (!videoId) return null;
  const at = Number(s.at);
  return {
    videoId,
    title: cleanText(s.title, 200),
    artist: cleanText(s.artist, 200),
    thumb: cleanText(s.thumb, 500),
    dur: Math.max(0, Number(s.dur) || 0),
    at: Number.isFinite(at) && at > 0 ? Math.floor(at) : Date.now(),
  };
}

function cleanPlaylist(p) {
  if (!p || typeof p !== "object") return null;
  const name = cleanText(p.name, 100);
  if (!name) return null;
  const songs = Array.isArray(p.songs)
    ? p.songs.map(cleanSong).filter(Boolean).slice(0, 500)
    : [];
  return { name, songs, updatedAt: Math.floor(Number(p.updatedAt) || 0) };
}

function requireDhun(req, res) {
  if (!req.user || req.user.app !== "dhun") {
    res.status(401).json({ message: "Invalid token" });
    return false;
  }
  return true;
}

router.get("/sync", protect, wrap(async (req, res) => {
  if (!requireDhun(req, res)) return;
  const user = await DhunUser.findById(req.user.id).select("liked recents playlists");
  if (!user) return res.status(404).json({ message: "User not found" });
  res.json({ liked: user.liked || [], recents: user.recents || [], playlists: user.playlists || [] });
}));

router.post("/sync", protect, wrap(async (req, res) => {
  if (!requireDhun(req, res)) return;
  const liked = Array.isArray(req.body.liked)
    ? req.body.liked.map(cleanSong).filter(Boolean).slice(0, 1000) : null;
  const recents = Array.isArray(req.body.recents)
    ? req.body.recents.map(cleanSong).filter(Boolean).slice(0, 50) : null;
  const playlists = Array.isArray(req.body.playlists)
    ? req.body.playlists.map(cleanPlaylist).filter(Boolean).slice(0, 50) : null;
  if (!liked || !recents || !playlists) return res.status(400).json({ message: "Invalid request" });

  const user = await DhunUser.findById(req.user.id);
  if (!user) return res.status(404).json({ message: "User not found" });
  user.liked = liked;
  user.recents = recents;
  user.playlists = playlists;
  await user.save();
  res.json({ ok: true, liked: liked.length, recents: recents.length, playlists: playlists.length });
}));

module.exports = router;
