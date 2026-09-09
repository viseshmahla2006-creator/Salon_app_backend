const express = require("express");
const Salon = require("../models/Salon");
const { protect, ownerOnly } = require("../middleware/auth");
const { createOrder, verifySignature } = require("../utils/razorpay");

const router = express.Router();
const SUBSCRIPTION_FEE = 199;

// OWNER: create or update salon (photo, services, prices)
router.post("/", protect, ownerOnly, async (req, res) => {
  try {
    const { shopName, city, area, address, photoUrl, services, openTime, closeTime } = req.body;

    let salon = await Salon.findOne({ owner: req.user.id });
    if (salon) {
      Object.assign(salon, { shopName, city, area, address, photoUrl, services, openTime, closeTime });
      await salon.save();
    } else {
      salon = await Salon.create({
        owner: req.user.id,
        shopName,
        city,
        area,
        address,
        photoUrl,
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
  res.json(salon);
});

router.get("/", async (req, res) => {
  try {
    const { city, area } = req.query;
    const filter = { subscriptionActive: true };
    if (city) filter.city = new RegExp(city, "i");
    if (area) filter.area = new RegExp(area, "i");

    const salons = await Salon.find(filter).populate("owner", "name phone");
    res.json(salons);
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

router.get("/:id", async (req, res) => {
  const salon = await Salon.findById(req.params.id).populate("owner", "name phone");
  if (!salon) return res.status(404).json({ message: "Salon not found" });
  res.json(salon);
});

router.post("/subscribe/create-order", protect, ownerOnly, async (req, res) => {
  try {
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
    newExpiry.setDate(newExpiry.getDate() + 30);

    salon.subscriptionActive = true;
    salon.subscriptionExpiresAt = newExpiry;
    await salon.save();

    res.json({ message: "Subscription is now active!", salon });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

router.patch("/status", protect, ownerOnly, async (req, res) => {
  try {
    const { isOpen, availabilityNote } = req.body;
    const salon = await Salon.findOne({ owner: req.user.id });
    if (!salon) return res.status(404).json({ message: "Salon not found" });
    if (typeof isOpen === "boolean") salon.isOpen = isOpen;
    if (typeof availabilityNote === "string") salon.availabilityNote = availabilityNote;
    await salon.save();
    res.json(salon);
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

module.exports = router;
