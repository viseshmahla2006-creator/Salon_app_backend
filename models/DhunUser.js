const mongoose = require("mongoose");

// A song reference for sync (no stream URL — the app re-resolves on demand).
const songSchema = new mongoose.Schema(
  {
    videoId: String,
    title: String,
    artist: String,
    thumb: String,
    dur: Number,
    at: Number, // client timestamp (ms) for ordering
  },
  { _id: false }
);

// Separate accounts for the Dhun music app (kept apart from SalonWale users).
const dhunUserSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true }, // bcrypt hash
    emailVerified: { type: Boolean, default: false }, // verified via email OTP at signup

    // Cloud sync: liked songs + recent plays follow the account across devices
    liked: { type: [songSchema], default: [] },
    recents: { type: [songSchema], default: [] },

    // Brute-force protection
    failedLogins: { type: Number, default: 0 },
    lockUntil: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model("DhunUser", dhunUserSchema);
