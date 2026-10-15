const mongoose = require("mongoose");

// Separate accounts for the Dhun music app (kept apart from SalonWale users).
const dhunUserSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true }, // bcrypt hash
    emailVerified: { type: Boolean, default: false }, // verified via email OTP at signup

    // Brute-force protection
    failedLogins: { type: Number, default: 0 },
    lockUntil: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model("DhunUser", dhunUserSchema);
