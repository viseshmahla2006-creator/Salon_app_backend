const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { OAuth2Client } = require("google-auth-library");
const User = require("../models/User");

const router = express.Router();
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

function generateToken(user) {
  return jwt.sign(
    {
      id: user._id,
      role: user.role,
    },
    process.env.JWT_SECRET,
    {
      expiresIn: "30d",
    }
  );
}

function cleanPhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

function userResponse(user) {
  return {
    id: user._id,
    name: user.name,
    phone: user.phone || "",
    email: user.email || "",
    role: user.role,
  };
}

/* =========================================================
   PHONE + PASSWORD REGISTER
   ========================================================= */

router.post("/register", async (req, res) => {
  try {
    const { name, phone, password, role } = req.body;

    if (!name || !phone || !password || !role) {
      return res.status(400).json({
        message: "Name, phone, password and role are required.",
      });
    }

    if (!["customer", "owner"].includes(role)) {
      return res.status(400).json({
        message: "Invalid account role.",
      });
    }

    const clean = cleanPhone(phone);

    if (clean.length !== 10) {
      return res.status(400).json({
        message: "Enter a valid 10-digit mobile number.",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        message: "Password must be at least 6 characters.",
      });
    }

    const existingUser = await User.findOne({ phone: clean });

    if (existingUser) {
      return res.status(400).json({
        message: "This mobile number is already registered. Please login.",
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await User.create({
      name: name.trim(),
      phone: clean,
      passwordHash,
      role,
    });

    const token = generateToken(user);

    res.status(201).json({
      message: "Account created successfully.",
      token,
      user: userResponse(user),
    });
  } catch (err) {
    console.error("Register error:", err);

    res.status(500).json({
      message: "Registration failed.",
      error: err.message,
    });
  }
});

/* =========================================================
   PHONE + PASSWORD LOGIN
   ========================================================= */

router.post("/login", async (req, res) => {
  try {
    const { phone, password, role } = req.body;

    if (!phone || !password || !role) {
      return res.status(400).json({
        message: "Phone, password and role are required.",
      });
    }

    if (!["customer", "owner"].includes(role)) {
      return res.status(400).json({
        message: "Invalid account role.",
      });
    }

    const clean = cleanPhone(phone);

    const user = await User.findOne({ phone: clean });

    if (!user) {
      return res.status(401).json({
        message: "Account not found. Please sign up first.",
      });
    }

    if (user.role !== role) {
      return res.status(400).json({
        message: `This mobile number is registered as a ${user.role}.`,
      });
    }

    if (!user.passwordHash) {
      return res.status(400).json({
        message: "This account does not have a password. Please use the account's original login method.",
      });
    }

    const passwordMatch = await bcrypt.compare(
      password,
      user.passwordHash
    );

    if (!passwordMatch) {
      return res.status(401).json({
        message: "Incorrect password.",
      });
    }

    const token = generateToken(user);

    res.json({
      message: "Login successful.",
      token,
      user: userResponse(user),
    });
  } catch (err) {
    console.error("Login error:", err);

    res.status(500).json({
      message: "Login failed.",
      error: err.message,
    });
  }
});

/* =========================================================
   GOOGLE SIGN-IN
   ========================================================= */

router.post("/google", async (req, res) => {
  try {
    const { credential, role } = req.body;

    if (!credential || !role) {
      return res.status(400).json({
        message: "Missing Google credential or role",
      });
    }

    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();

    const {
      sub: googleId,
      email,
      name,
    } = payload;

    let user = await User.findOne({
      email: email.toLowerCase(),
    });

    if (user) {
      if (user.role !== role) {
        return res.status(400).json({
          message: `This email is already registered as a ${user.role}.`,
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
      user: userResponse(user),
    });
  } catch (err) {
    console.error("Google login error:", err);

    res.status(500).json({
      message: "Google sign-in failed",
      error: err.message,
    });
  }
});

/* =========================================================
   GET CURRENT USER PROFILE
   ========================================================= */

router.get("/me", async (req, res) => {
  try {
    const header = req.headers.authorization || "";

    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({
        message: "Not authenticated.",
      });
    }

    const token = header.split(" ")[1];

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(404).json({
        message: "User not found.",
      });
    }

    res.json({
      user: userResponse(user),
    });
  } catch (err) {
    res.status(401).json({
      message: "Invalid or expired token.",
    });
  }
});

module.exports = router;
