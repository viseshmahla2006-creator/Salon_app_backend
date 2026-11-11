// BossCall — AI workers report to Muse (the manager); Muse calls Visesh.
// Mounted at /api/bosscall. In-memory queue only (same pattern as the
// OTP store in dhun.js) — calls do not survive a server restart.
// Every endpoint requires header X-Boss-Key == process.env.BOSSCALL_KEY.
const express = require("express");
const { wrap } = require("../utils/security");

// NOTE: do NOT use crypto.randomBytes here — on Render's free-tier
// containers the sync CSPRNG call can block for minutes (low entropy),
// which hung every valid POST /call while all other endpoints stayed
// fast. Call ids are only queue identifiers behind the X-Boss-Key auth,
// so a timestamp + counter + Math.random id is enough and never blocks.
let callSeq = 0;
function newCallId() {
  callSeq += 1;
  return `c${Date.now().toString(36)}${callSeq.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

const router = express.Router();

// ---------- In-memory store ----------
const calls = []; // { id, type, title, message, status, createdAt, answer, replyText, answeredAt }

const TYPES = ["update", "question", "approval"];
const ANSWERS = ["yes", "no", "ok"];

function requireBossKey(req, res, next) {
  const expected = process.env.BOSSCALL_KEY;
  const given = req.headers["x-boss-key"];
  if (!expected || !given || given !== expected) {
    return res.status(401).json({ ok: false, message: "Unauthorized" });
  }
  next();
}

router.use(requireBossKey);

function cleanStr(v, max = 500) {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, max);
}

// POST /api/bosscall/call — queue a new call for the boss
router.post("/call", wrap(async (req, res) => {
  const type = req.body && req.body.type;
  const title = cleanStr(req.body && req.body.title, 200);
  const message = cleanStr(req.body && req.body.message, 2000);
  if (!TYPES.includes(type)) {
    return res.status(400).json({ ok: false, message: "type must be update, question or approval" });
  }
  if (!title || !message) {
    return res.status(400).json({ ok: false, message: "title and message are required" });
  }
  const call = {
    id: newCallId(),
    type,
    title,
    message,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  calls.push(call);
  res.status(201).json({ ok: true, call });
}));

// GET /api/bosscall/pending — oldest pending call, or null
router.get("/pending", wrap(async (req, res) => {
  const call = calls.find((c) => c.status === "pending") || null;
  res.json({ ok: true, call });
}));

// POST /api/bosscall/reply — answer a call (boss said yes/no/ok)
router.post("/reply", wrap(async (req, res) => {
  const id = cleanStr(req.body && req.body.id, 100);
  const answer = req.body && req.body.answer;
  const replyText = cleanStr(req.body && req.body.replyText, 2000);
  if (!ANSWERS.includes(answer)) {
    return res.status(400).json({ ok: false, message: "answer must be yes, no or ok" });
  }
  const call = calls.find((c) => c.id === id);
  if (!call) return res.status(404).json({ ok: false, message: "Call not found" });
  call.status = "answered";
  call.answer = answer;
  if (replyText) call.replyText = replyText;
  call.answeredAt = new Date().toISOString();
  res.json({ ok: true });
}));

// GET /api/bosscall/replies — answered calls, newest first
router.get("/replies", wrap(async (req, res) => {
  const answered = calls
    .filter((c) => c.status === "answered")
    .slice()
    .sort((a, b) => new Date(b.answeredAt) - new Date(a.answeredAt));
  res.json({ ok: true, calls: answered });
}));

module.exports = router;
