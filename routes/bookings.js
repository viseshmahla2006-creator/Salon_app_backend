const express = require("express");
const Booking = require("../models/Booking");
const Salon = require("../models/Salon");
const { protect } = require("../middleware/auth");
const { createOrder, verifySignature } = require("../utils/razorpay");

const router = express.Router();
const PLATFORM_FEE = 15;

// CUSTOMER: booking start karo -> ₹15 ka Razorpay order banega
router.post("/create-order", protect, async (req, res) => {
  try {
    const { salonId, serviceName, servicePrice, bookingTime } = req.body;

    const salon = await Salon.findById(salonId);
    if (!salon || !salon.subscriptionActive) {
      return res.status(400).json({ message: "Ye salon abhi available nahi hai" });
    }

    const order = await createOrder(PLATFORM_FEE, `booking_${req.user.id}_${Date.now()}`);

    // pending booking bana do, payment verify hone par confirm hogi
    const booking = await Booking.create({
      customer: req.user.id,
      salon: salonId,
      serviceName,
      servicePrice,
      bookingTime,
      platformFee: PLATFORM_FEE,
      razorpayOrderId: order.id,
      paymentStatus: "pending",
    });

    res.json({ order, key: process.env.RAZORPAY_KEY_ID, bookingId: booking._id });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// CUSTOMER: payment verify -> booking confirm
router.post("/verify", protect, async (req, res) => {
  try {
    const { bookingId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    const valid = verifySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
    if (!valid) return res.status(400).json({ message: "Payment verify nahi hua" });

    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ message: "Booking nahi mili" });

    booking.paymentStatus = "paid";
    booking.razorpayPaymentId = razorpay_payment_id;
    booking.status = "confirmed";
    await booking.save();

    res.json({ message: "Booking confirm ho gayi!", booking });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// CUSTOMER: apni bookings dekhna
router.get("/my-bookings", protect, async (req, res) => {
  const bookings = await Booking.find({ customer: req.user.id })
    .populate("salon", "shopName address")
    .sort({ bookingTime: -1 });
  res.json(bookings);
});

// OWNER: apne salon ki bookings dekhna
router.get("/salon/:salonId", protect, async (req, res) => {
  const bookings = await Booking.find({ salon: req.params.salonId, paymentStatus: "paid" })
    .populate("customer", "name phone")
    .sort({ bookingTime: 1 });
  res.json(bookings);
});

module.exports = router;
