const express = require("express");
const Booking = require("../models/Booking");
const Salon = require("../models/Salon");
const { protect } = require("../middleware/auth");
const { createOrder, verifySignature } = require("../utils/razorpay");

const router = express.Router();
const PLATFORM_FEE = 15;

// CUSTOMER: send a booking request (no payment yet — that happens only after acceptance)
router.post("/request", protect, async (req, res) => {
  try {
    const { salonId, serviceName, servicePrice, requestedTime } = req.body;

    const salon = await Salon.findById(salonId);
    if (!salon || !salon.subscriptionActive) {
      return res.status(400).json({ message: "This salon is not currently available" });
    }

    const booking = await Booking.create({
      customer: req.user.id,
      salon: salonId,
      serviceName,
      servicePrice,
      requestedTime,
      status: "pending",
    });

    res.status(201).json(booking);
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// CUSTOMER: see my requests/bookings
router.get("/my-bookings", protect, async (req, res) => {
  const bookings = await Booking.find({ customer: req.user.id })
    .populate("salon", "shopName address")
    .sort({ createdAt: -1 });
  res.json(bookings);
});

// OWNER: see requests for my salon
router.get("/salon/:salonId", protect, async (req, res) => {
  try {
    const salon = await Salon.findById(req.params.salonId);
    if (!salon || String(salon.owner) !== req.user.id) {
      return res.status(403).json({ message: "Not authorized for this salon" });
    }
    const bookings = await Booking.find({ salon: req.params.salonId })
      .populate("customer", "name phone")
      .sort({ createdAt: -1 });
    res.json(bookings);
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

async function loadOwnedBooking(bookingId, userId) {
  const booking = await Booking.findById(bookingId).populate("salon");
  if (!booking) return { error: "Booking not found" };
  if (String(booking.salon.owner) !== userId) return { error: "Not authorized" };
  return { booking };
}

// OWNER: accept a request (says "I'm free at this time")
router.patch("/:id/accept", protect, async (req, res) => {
  const { booking, error } = await loadOwnedBooking(req.params.id, req.user.id);
  if (error) return res.status(403).json({ message: error });
  booking.status = "accepted";
  await booking.save();
  res.json(booking);
});

// OWNER: reject a request (optionally say when they'll be free)
router.patch("/:id/reject", protect, async (req, res) => {
  const { booking, error } = await loadOwnedBooking(req.params.id, req.user.id);
  if (error) return res.status(403).json({ message: error });
  booking.status = "rejected";
  booking.rejectionNote = req.body.note || "";
  await booking.save();
  res.json(booking);
});

// OWNER: cancel a request that was accepted but never paid (frees up the slot)
router.patch("/:id/cancel", protect, async (req, res) => {
  const { booking, error } = await loadOwnedBooking(req.params.id, req.user.id);
  if (error) return res.status(403).json({ message: error });
  booking.status = "cancelled";
  await booking.save();
  res.json(booking);
});

// CUSTOMER: create a ₹15 Razorpay order — only allowed once the owner has accepted
router.post("/:id/create-payment-order", protect, async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking || String(booking.customer) !== req.user.id) {
      return res.status(403).json({ message: "Not authorized" });
    }
    if (booking.status !== "accepted") {
      return res.status(400).json({ message: "This booking hasn't been accepted yet" });
    }
    if (booking.paymentStatus === "paid") {
      return res.status(400).json({ message: "Already paid" });
    }

    const order = await createOrder(PLATFORM_FEE, `booking_${booking._id}_${Date.now()}`);
    booking.razorpayOrderId = order.id;
    await booking.save();

    res.json({ order, key: process.env.RAZORPAY_KEY_ID, bookingId: booking._id });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// CUSTOMER: verify payment for an accepted booking
router.post("/:id/verify-payment", protect, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const valid = verifySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
    if (!valid) return res.status(400).json({ message: "Payment could not be verified" });

    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    booking.paymentStatus = "paid";
    booking.razorpayPaymentId = razorpay_payment_id;
    await booking.save();

    res.json({ message: "Payment confirmed", booking });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

module.exports = router;
