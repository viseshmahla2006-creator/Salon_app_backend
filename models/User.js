const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    googleId: { type: String, unique: true, sparse: true },
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true },
    phone: { type: String },
    role: { type: String, enum: ["customer", "owner"], required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);
