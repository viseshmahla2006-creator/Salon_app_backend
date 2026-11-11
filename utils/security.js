// Security + validation helpers (no extra packages needed)
const mongoose = require("mongoose");

// ---------- Security headers (same idea as "helmet") ----------
function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.removeHeader("X-Powered-By");
  next();
}

// ---------- Remove Mongo operators ($ne, $gt...) from user input ----------
function stripOperators(obj) {
  if (!obj || typeof obj !== "object") return obj;
  for (const key of Object.keys(obj)) {
    if (key.startsWith("$") || key.includes(".")) {
      delete obj[key];
    } else {
      stripOperators(obj[key]);
    }
  }
  return obj;
}
function sanitizeInput(req, res, next) {
  stripOperators(req.body);
  stripOperators(req.query);
  stripOperators(req.params);
  next();
}

// ---------- Rate limiter (in memory) ----------
function rateLimit({ windowMs, max, message }) {
  const hits = new Map(); // key -> { count, resetAt }
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, Math.max(windowMs, 60000)).unref();

  return function limiter(req, res, next) {
    const key = req.ip || "unknown";
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    if (entry.count > max) {
      const wait = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader("Retry-After", wait);
      return res.status(429).json({ message: message || `Too many requests. Try again in ${wait} seconds.` });
    }
    next();
  };
}

// ---------- Async wrapper: any crash inside a route becomes a clean 500 ----------
function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => serverError(res, err, req.originalUrl));
}

function serverError(res, err, where = "") {
  console.error("SERVER ERROR", where, err);
  if (res.headersSent) return;
  const body = { message: "Server error, please try again" };
  if (process.env.DEBUG_ERRORS === "1") body.error = err.message; // only for debugging, set in Render env
  res.status(500).json(body);
}

// ---------- Validators ----------
function cleanPhone(input) {
  const digits = String(input || "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}
function isValidPhone(phone) {
  return /^[6-9]\d{9}$/.test(phone); // Indian mobile numbers
}
function cleanEmail(input) {
  return String(input || "").trim().toLowerCase();
}
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "")) && email.length <= 254;
}
function cleanText(input, max = 200) {
  return String(input == null ? "" : input).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}
function isObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) && String(id).length === 24;
}
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
// Photos: either a normal https link (Cloudinary) or a small base64 image
function cleanPhoto(value) {
  if (!value || typeof value !== "string") return "";
  if (/^https:\/\/[^\s]+$/.test(value) && value.length < 500) return value;
  if (/^data:image\/(jpeg|png|webp);base64,/.test(value) && value.length < 1500000) return value;
  return "";
}

module.exports = {
  securityHeaders, sanitizeInput, rateLimit, wrap, serverError,
  cleanPhone, isValidPhone, cleanEmail, isValidEmail, cleanText, isObjectId, escapeRegex, cleanPhoto,
};
