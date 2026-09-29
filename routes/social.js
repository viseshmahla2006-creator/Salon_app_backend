// Reviews, Favorites and Reports (mounted under /api)
const express = require("express");
const { Review, Favorite, Report } = require("../models/Extras");
const Booking = require("../models/Booking");
const Salon = require("../models/Salon");
const { protect } = require("../middleware/auth");
const { isSubscriptionActive } = require("../utils/salonStatus");
const { wrap, rateLimit, cleanText, isObjectId } = require("../utils/security");

const router = express.Router();
const reportLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10 });

// ================= REVIEWS =================

// Leave a review for a confirmed booking whose time has passed (one per booking)
router.post("/reviews", protect, wrap(async (req, res) => {
  const { bookingId } = req.body;
  const rating = Number(req.body.rating);
  const comment = cleanText(req.body.comment, 500);

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ message: "Rating 1 se 5 ke beech honi chahiye" });
  }
  if (!isObjectId(bookingId)) return res.status(400).json({ message: "Invalid booking" });

  const booking = await Booking.findById(bookingId);
  if (!booking || String(booking.customer) !== req.user.id) {
    return res.status(403).json({ message: "Not authorized" });
  }
  if (!(booking.status === "accepted" && booking.paymentStatus === "paid")) {
    return res.status(400).json({ message: "You can only review a confirmed booking" });
  }
  if (booking.requestedTime > new Date()) {
    return res.status(400).json({ message: "Appointment ke baad review de sakte hain" });
  }
  if (booking.reviewed) return res.status(400).json({ message: "You've already reviewed this booking" });

  let review;
  try {
    review = await Review.create({ customer: req.user.id, salon: booking.salon, booking: booking._id, rating, comment });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ message: "You've already reviewed this booking" });
    throw err;
  }
  booking.reviewed = true;
  await booking.save();

  // Recalculate from all reviews so the average is always exact
  const [agg] = await Review.aggregate([
    { $match: { salon: booking.salon } },
    { $group: { _id: "$salon", avg: { $avg: "$rating" }, count: { $sum: 1 } } },
  ]);
  await Salon.findByIdAndUpdate(booking.salon, {
    averageRating: agg ? Math.round(agg.avg * 10) / 10 : rating,
    reviewCount: agg ? agg.count : 1,
  });

  res.status(201).json(review);
}));

// Public: a salon's reviews
router.get("/reviews/salon/:salonId", wrap(async (req, res) => {
  if (!isObjectId(req.params.salonId)) return res.json([]);
  const reviews = await Review.find({ salon: req.params.salonId })
    .populate("customer", "name")
    .sort({ createdAt: -1 })
    .limit(30);
  // only first name is shown publicly
  res.json(reviews.map((r) => ({
    _id: r._id, rating: r.rating, comment: r.comment, createdAt: r.createdAt,
    name: ((r.customer && r.customer.name) || "Customer").split(" ")[0],
  })));
}));

// ================= FAVORITES =================

router.post("/favorites/toggle", protect, wrap(async (req, res) => {
  const { salonId } = req.body;
  if (!isObjectId(salonId)) return res.status(400).json({ message: "Invalid salon" });

  const existing = await Favorite.findOne({ customer: req.user.id, salon: salonId });
  if (existing) {
    await existing.deleteOne();
    return res.json({ favorited: false });
  }
  if (!(await Salon.exists({ _id: salonId }))) return res.status(404).json({ message: "Salon not found" });
  if ((await Favorite.countDocuments({ customer: req.user.id })) >= 100) {
    return res.status(400).json({ message: "Aap 100 se zyada favorites nahi rakh sakte" });
  }
  try {
    await Favorite.create({ customer: req.user.id, salon: salonId });
  } catch (err) {
    if (err.code !== 11000) throw err; // double tap — already saved
  }
  res.json({ favorited: true });
}));

// My favorite salons (only ones still listed)
router.get("/favorites", protect, wrap(async (req, res) => {
  const favs = await Favorite.find({ customer: req.user.id }).sort({ createdAt: -1 }).populate({
    path: "salon",
    populate: { path: "owner", select: "name" },
  });
  const salons = favs
    .map((f) => f.salon)
    .filter((s) => s && isSubscriptionActive(s))
    .map((s) => {
      const o = s.toObject();
      o.owner = o.owner && o.owner.name ? { name: o.owner.name } : undefined;
      return o;
    });
  res.json(salons);
}));

// Just the ids (used to paint the hearts on the search list)
router.get("/favorites/ids", protect, wrap(async (req, res) => {
  const favs = await Favorite.find({ customer: req.user.id }).select("salon");
  res.json(favs.map((f) => String(f.salon)));
}));

// ================= REPORTS =================

router.post("/reports", protect, reportLimiter, wrap(async (req, res) => {
  const { salonId } = req.body;
  const reason = cleanText(req.body.reason, 500);
  if (!isObjectId(salonId)) return res.status(400).json({ message: "Invalid salon" });
  if (reason.length < 5) return res.status(400).json({ message: "Problem thodi detail mein likhein" });
  if (!(await Salon.exists({ _id: salonId }))) return res.status(404).json({ message: "Salon not found" });

  const already = await Report.findOne({ reporter: req.user.id, salon: salonId, status: "open" });
  if (already) return res.status(400).json({ message: "Aap is salon ko pehle hi report kar chuke hain. Hum dekh rahe hain." });

  await Report.create({ reporter: req.user.id, salon: salonId, reason });
  res.status(201).json({ message: "Shukriya — hum ise check karenge." });
}));

module.exports = router;
