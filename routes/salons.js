const express = require("express");
const Salon = require("../models/Salon");
const { protect, ownerOnly } = require("../middleware/auth");
const { createOrder, verifySignature } = require("../utils/razorpay");
const { isSubscriptionActive, applyTempOpenExpiry } = require("../utils/salonStatus");

const router = express.Router();
const SUBSCRIPTION_FEE = 199;
const SUBSCRIPTION_DAYS = 29;
const FREE_COUPON = "TMKC";
const TEST_OPEN_CODE = "MKCC";
const TEST_OPEN_MINUTES = 10;

// OWNER: create or update salon (photo, services, prices)
router.post("/", protect, ownerOnly, async (req, res) => {
  try {
    const { shopName, city, area, address, photoUrl, galleryPhotos, services, openTime, closeTime } = req.body;

    let salon = await Salon.findOne({ owner: req.user.id });
    if (salon) {
      Object.assign(salon, { shopName, city, area, address, photoUrl, galleryPhotos, services, openTime, closeTime });
      await salon.save();
    } else {
      salon = await Salon.create({
        owner: req.user.id,
        shopName,
        city,
        area,
        address,
        photoUrl,
        galleryPhotos,
        services,
        openTime,
        closeTime,
      });
    }
    res.json(salon);
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

router.get("/my-salon", protect, ownerOnly, async (req, res) => {
  const salon = await Salon.findOne({ owner: req.user.id });
  if (salon && applyTempOpenExpiry(salon)) await salon.save();
  res.json(salon);
});

// CUSTOMER: area/city search — only shows salons with an active (unexpired) subscription
router.get("/", async (req, res) => {
  try {
    const { city, area } = req.query;
    const filter = {};
    if (city) filter.city = new RegExp(city, "i");
    if (area) filter.area = new RegExp(area, "i");

    let salons = await Salon.find(filter).populate("owner", "name phone");

    const saves = [];
    for (const s of salons) {
      if (applyTempOpenExpiry(s)) saves.push(s.save());
    }
    await Promise.all(saves);

    salons = salons.filter((s) => isSubscriptionActive(s));
    res.json(salons);
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

router.get("/:id", async (req, res) => {
  const salon = await Salon.findById(req.params.id).populate("owner", "name phone");
  if (!salon) return res.status(404).json({ message: "Salon not found" });
  if (applyTempOpenExpiry(salon)) await salon.save();
  res.json(salon);
});

router.post("/subscribe/create-order", protect, ownerOnly, async (req, res) => {
  try {
    const couponCode = (req.body.couponCode || "").trim().toUpperCase();
    if (couponCode === FREE_COUPON) {
      const salon = await Salon.findOne({ owner: req.user.id });
      if (!salon) return res.status(404).json({ message: "Please create your salon first" });

      const now = new Date();
      const currentExpiry = salon.subscriptionExpiresAt && salon.subscriptionExpiresAt > now
        ? salon.subscriptionExpiresAt
        : now;
      const newExpiry = new Date(currentExpiry);
      newExpiry.setDate(newExpiry.getDate() + SUBSCRIPTION_DAYS);

      salon.subscriptionActive = true;
      salon.subscriptionExpiresAt = newExpiry;
      await salon.save();

      return res.json({ free: true, message: "Subscription activated for free with your coupon!", salon });
    }

    const order = await createOrder(SUBSCRIPTION_FEE, `sub_${req.user.id}_${Date.now()}`);
    res.json({ order, key: process.env.RAZORPAY_KEY_ID });
  } catch (err) {
    res.status(500).json({ message: "Error creating order", error: err.message });
  }
});

router.post("/subscribe/verify", protect, ownerOnly, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    const valid = verifySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
    if (!valid) return res.status(400).json({ message: "Payment could not be verified" });

    const salon = await Salon.findOne({ owner: req.user.id });
    if (!salon) return res.status(404).json({ message: "Please create your salon first" });

    const now = new Date();
    const currentExpiry = salon.subscriptionExpiresAt && salon.subscriptionExpiresAt > now
      ? salon.subscriptionExpiresAt
      : now;
    const newExpiry = new Date(currentExpiry);
    newExpiry.setDate(newExpiry.getDate() + SUBSCRIPTION_DAYS);

    salon.subscriptionActive = true;
    salon.subscriptionExpiresAt = newExpiry;
    await salon.save();

    res.json({ message: "Subscription is now active!", salon });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// OWNER: toggle open/closed + availability note. Blocked if subscription has expired.
router.patch("/status", protect, ownerOnly, async (req, res) => {
  try {
    const { isOpen, availabilityNote } = req.body;
    const salon = await Salon.findOne({ owner: req.user.id });
    if (!salon) return res.status(404).json({ message: "Salon not found" });

    if (isOpen === true && !isSubscriptionActive(salon)) {
      return res.status(400).json({ message: "Your subscription has expired. Renew it to open your shop." });
    }

    if (typeof isOpen === "boolean") {
      salon.isOpen = isOpen;
      salon.tempOpenExpiresAt = undefined; // a manual toggle cancels any test-open timer
    }
    if (typeof availabilityNote === "string") salon.availabilityNote = availabilityNote;
    await salon.save();
    res.json(salon);
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// OWNER: test code that opens the shop for 10 minutes, auto-closes after — no subscription needed
router.post("/test-open", protect, ownerOnly, async (req, res) => {
  try {
    const code = (req.body.code || "").trim().toUpperCase();
    if (code !== TEST_OPEN_CODE) {
      return res.status(400).json({ message: "Invalid code" });
    }

    const salon = await Salon.findOne({ owner: req.user.id });
    if (!salon) return res.status(404).json({ message: "Please create your salon first" });

    salon.isOpen = true;
    salon.tempOpenExpiresAt = new Date(Date.now() + TEST_OPEN_MINUTES * 60 * 1000);
    await salon.save();

    res.json({ message: `Shop opened for ${TEST_OPEN_MINUTES} minutes (test mode).`, salon });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

module.exports = router;
