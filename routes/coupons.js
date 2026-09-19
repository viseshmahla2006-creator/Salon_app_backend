const express = require("express");
const router = express.Router();

// Add more valid codes here later if needed
const VALID_COUPONS = ["TMKC"];

// Lightweight check — just tells the frontend if a code is valid, doesn't charge anything.
// The actual payment routes re-check this server-side too, so this can't be bypassed.
router.post("/verify", (req, res) => {
  const code = (req.body.code || "").trim().toUpperCase();
  if (VALID_COUPONS.includes(code)) {
    return res.json({ valid: true, message: "Coupon applied — you'll pay ₹0!" });
  }
  res.json({ valid: false, message: "Invalid coupon code" });
});

module.exports = router;
