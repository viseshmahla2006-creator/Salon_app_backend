const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");

const router = express.Router();


// ===============================
// HELPER FUNCTIONS
// ===============================

function cleanPhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

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


// ===============================
// REGISTER
// Phone + Password
// ===============================

router.post("/register", async (req, res) => {
  try {
    const { name, phone, password, role } = req.body;

    // Check fields
    if (!name || !phone || !password || !role) {
      return res.status(400).json({
        message: "Please fill in all fields",
      });
    }

    // Check role
    if (!["customer", "owner"].includes(role)) {
      return res.status(400).json({
        message: "Invalid role",
      });
    }

    // Clean phone number
    const cleanPhoneNumber = cleanPhone(phone);

    // Check phone length
    if (cleanPhoneNumber.length !== 10) {
      return res.status(400).json({
        message: "Please enter a valid 10-digit phone number",
      });
    }

    // Check password
    if (password.length < 4) {
      return res.status(400).json({
        message: "Password must be at least 4 characters",
      });
    }

    // Check existing account
    const existingUser = await User.findOne({
      phone: cleanPhoneNumber,
    });

    if (existingUser) {
      return res.status(400).json({
        message: "An account with this phone number already exists",
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const user = await User.create({
      name: name.trim(),
      phone: cleanPhoneNumber,
      password: hashedPassword,
      role,
    });

    // Generate token
    const token = generateToken(user);

    return res.status(201).json({
      message: "Account created successfully",
      token,
      user: {
        id: user._id,
        name: user.name,
        phone: user.phone,
        role: user.role,
      },
    });

  } catch (err) {
    console.error("REGISTER ERROR:", err);

    return res.status(500).json({
      message: "Server error",
      error: err.message,
    });
  }
});


// ===============================
// LOGIN
// Phone + Password
// ===============================

router.post("/login", async (req, res) => {
  try {
    const { phone, password } = req.body;

    // Check fields
    if (!phone || !password) {
      return res.status(400).json({
        message: "Please enter phone number and password",
      });
    }

    // Clean phone number
    const cleanPhoneNumber = cleanPhone(phone);

    // Find user
    const user = await User.findOne({
      phone: cleanPhoneNumber,
    });

    if (!user) {
      return res.status(400).json({
        message: "Incorrect phone number or password",
      });
    }

    // Check password
    const isMatch = await bcrypt.compare(
      password,
      user.password
    );

    if (!isMatch) {
      return res.status(400).json({
        message: "Incorrect phone number or password",
      });
    }

    // Generate token
    const token = generateToken(user);

    return res.json({
      message: "Login successful",
      token,
      user: {
        id: user._id,
        name: user.name,
        phone: user.phone,
        role: user.role,
      },
    });

  } catch (err) {
    console.error("LOGIN ERROR:", err);

    return res.status(500).json({
      message: "Server error",
      error: err.message,
    });
  }
});


module.exports = router;
