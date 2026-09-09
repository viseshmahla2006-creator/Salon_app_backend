const express = require("express");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const User = require("../models/User");

const router = express.Router();
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

function generateToken(user) {
  return jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: "30d",
  });
}

// GOOGLE SIGN-IN — verifies the Google ID token, then creates or logs in the user
router.post("/google", async (req, res) => {
  try {
    const { credential, role } = req.body;
    if (!credential || !role) {
      return res.status(400).json({ message: "Missing Google credential or role" });
    }

    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const { sub: googleId, email, name } = payload;

    let user = await User.findOne({ email: email.toLowerCase() });

    if (user) {
      if (user.role !== role) {
        return res.status(400).json({
          message: `This email is already registered as a ${user.role}. Use a different Google account to sign in as a ${role}.`,
        });
      }
      if (!user.googleId) {
        user.googleId = googleId;
        await user.save();
      }
    } else {
      user = await User.create({
        googleId,
        name,
        email: email.toLowerCase(),
        role,
      });
    }

    const token = generateToken(user);
    res.json({
      token,
      user: { id: user._id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    res.status(500).json({ message: "Google sign-in failed", error: err.message });
  }
});

module.exports = router;
