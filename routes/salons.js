const express = require("express");
const Salon = require("../models/Salon");
const { protect, ownerOnly } = require("../middleware/auth");
const { createOrder, verifySignature } = require("../utils/razorpay");
const { isSubscriptionActive, applyTempOpenExpiry } = require("../utils/salonStatus");
const { wrap, rateLimit, cleanText, cleanPhoto, isObjectId, escapeRegex } = require("../utils/security");

const router = express.Router();
const SUBSCRIPTION_FEE = 199;
const SUBSCRIPTION_DAYS = 29;
const FREE_COUPON = "TMKC";
const TEST_OPEN_CODE = "MKCC";
const TEST_OPEN_MINUTES = 10;

const codeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 15 });

function publicSalon(salon) {
  const s = salon.toObject ? salon.toObject() : salon;
  s.owner = s.owner && s.owner.name ? { name: s.owner.name } : undefined;
  return s;
}

function cleanServices(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const sv of list.slice(0, 30)) {
    const name = cleanText(sv && sv.name, 40);
    const price = Number(sv && sv.price);
    if (!name || !Number.isFinite(price) || price < 1 || price > 100000) continue;
    out.push({ name, price: Math.round(price), icon: cleanText(sv.icon, 4) || "✂️" });
  }
  return out;
}

function cleanTime(t) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? t : undefined;
}

router.post("/", protect, ownerOnly, wrap(async (req, res) => {
  const b = req.body;
  const data = {
    shopName: cleanText(b.shopName, 60),
    city: cleanText(b.city, 40),
    area: cleanText(b.area, 60),
    address: cleanText(b.address, 200),
  };
  if (data.shopName.length < 2) return res.status(400).json({ message: "Enter your shop name" });
  if (!data.city) return res.status(400).json({ message: "Enter your city" });
  if (!data.area) return res.status(400).json({ message: "Enter your area" });
  if (data.address.length < 5) return res.status(400).json({ message: "Enter your full address" });

  const services = cleanServices(b.services);
  if (!services || !services.length) return res.status(400).json({ message: "Add at least one service (name + price)" });
  data.services = services;

  if (b.photoUrl !== undefined) data.photoUrl = cleanPhoto(b.photoUrl);
  if (Array.isArray(b.galleryPhotos)) data.galleryPhotos = b.galleryPhotos.slice(0, 8).map(cleanPhoto).filter(Boolean);
  if (cleanTime(b.openTime)) data.openTime = b.openTime;
  if (cleanTime(b.closeTime)) data.closeTime = b.closeTime;

  if (b.location && b.location.lat != null && b.location.lng != null) {
    const lat = Number(b.location.lat);
    const lng = Number(b.location.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      data.location = { lat, lng };
    }
  }

  let salon = await Salon.findOne({ owner: req.user.id });
  if (salon) {
    Object.assign(salon, data);
    await salon.save();
  } else {
    salon = await Salon.create({ owner: req.user.id, ...data });
  }
  res.json(salon);
}));

router.get("/my-salon", protect, ownerOnly, wrap(async (req, res) => {
  const salon = await Salon.findOne({ owner: req.user.id });
  if (salon && applyTempOpenExpiry(salon)) await salon.save();
  res.json(salon);
}));

router.get("/", wrap(async (req, res) => {
  const city = cleanText(req.query.city, 40);
  const area = cleanText(req.query.area, 60);
  const filter = {};
  if (city) filter.city = new RegExp(escapeRegex(city), "i");
  if (area) filter.area = new RegExp(escapeRegex(area), "i");

  let salons = await Salon.find(filter).populate("owner", "name");

  const saves = [];
  for (const s of salons) {
    if (applyTempOpenExpiry(s)) saves.push(s.save());
  }
  await Promise.all(saves);

  salons = salons.filter((s) => isSubscriptionActive(s));
  res.json(salons.map(publicSalon));
}));

router.get("/:id", wrap(async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(404).json({ message: "Salon not found" });
  const salon = await Salon.findById(req.params.id).populate("owner", "name");
  if (!salon || !isSubscriptionActive(salon)) return res.status(404).json({ message: "Salon not found" });
  if (applyTempOpenExpiry(salon)) await salon.save();
  res.json(publicSalon(salon));
}));

function extendSubscription(salon) {
  const now = new Date();
  const currentExpiry = salon.subscriptionExpiresAt && salon.subscriptionExpiresAt > now ? salon.subscriptionExpiresAt : now;
  const newExpiry = new Date(currentExpiry);
  newExpiry.setDate(newExpiry.getDate() + SUBSCRIPTION_DAYS);
  salon.subscriptionActive = true;
  salon.subscriptionExpiresAt = newExpiry;
}

router.post("/subscribe/create-order", protect, ownerOnly, codeLimiter, wrap(async (req, res) => {
  const couponCode = cleanText(req.body.couponCode, 20).toUpperCase();
  if (couponCode === FREE_COUPON) {
    const salon = await Salon.findOne({ owner: req.user.id });
    if (!salon) return res.status(404).json({ message: "Please create your salon first" });
    extendSubscription(salon);
    await salon.save();
    return res.json({ free: true, message: "Subscription activated for free with your coupon!", salon });
  }

  const order = await createOrder(SUBSCRIPTION_FEE, `sub_${req.user.id}_${Date.now()}`);
  res.json({ order, key: process.env.RAZORPAY_KEY_ID });
}));

router.post("/subscribe/verify", protect, ownerOnly, wrap(async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  const valid = verifySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
  if (!valid) return res.status(400).json({ message: "Payment could not be verified" });

  const salon = await Salon.findOne({ owner: req.user.id });
  if (!salon) return res.status(404).json({ message: "Please create your salon first" });

  if (salon.lastSubscriptionPaymentId === razorpay_payment_id) {
    return res.status(400).json({ message: "This payment has already been used" });
  }
  salon.lastSubscriptionPaymentId = razorpay_payment_id;
  extendSubscription(salon);
  await salon.save();

  res.json({ message: "Subscription is now active!", salon });
}));

router.patch("/status", protect, ownerOnly, wrap(async (req, res) => {
  const { isOpen } = req.body;
  const salon = await Salon.findOne({ owner: req.user.id });
  if (!salon) return res.status(404).json({ message: "Salon not found" });

  if (isOpen === true && !isSubscriptionActive(salon)) {
    return res.status(400).json({ message: "Your subscription has expired. Renew it to open your shop." });
  }

  if (typeof isOpen === "boolean") {
    salon.isOpen = isOpen;
    salon.tempOpenExpiresAt = undefined;
  }
  if (typeof req.body.availabilityNote === "string") salon.availabilityNote = cleanText(req.body.availabilityNote, 80);
  await salon.save();
  res.json(salon);
}));

router.post("/test-open", protect, ownerOnly, codeLimiter, wrap(async (req, res) => {
  const code = cleanText(req.body.code, 20).toUpperCase();
  if (code !== TEST_OPEN_CODE) return res.status(400).json({ message: "Invalid code" });

  const salon = await Salon.findOne({ owner: req.user.id });
  if (!salon) return res.status(404).json({ message: "Please create your salon first" });

  salon.isOpen = true;
  salon.tempOpenExpiresAt = new Date(Date.now() + TEST_OPEN_MINUTES * 60 * 1000);
  await salon.save();

  res.json({ message: `Shop opened for ${TEST_OPEN_MINUTES} minutes (test mode).`, salon });
}));

module.exports = router;
