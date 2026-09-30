const express = require("express");
const Booking = require("../models/Booking");
const Salon = require("../models/Salon");
const User = require("../models/User");
const { protect } = require("../middleware/auth");
const { createOrder, verifySignature, refundPayment } = require("../utils/razorpay");
const { isSubscriptionActive } = require("../utils/salonStatus");
const { wrap, rateLimit, cleanText, isObjectId } = require("../utils/security");
const wa = require("../utils/whatsapp");

const router = express.Router();
const PLATFORM_FEE = 15;
const FREE_COUPON = "TMKC";
const MAX_ACTIVE_REQUESTS = 5;
const STALE_AFTER_MS = 30 * 60 * 1000;

const codeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });

async function expireStale(filter) {
  await Booking.updateMany(
    {
      ...filter,
      status: { $in: ["pending", "accepted"] },
      paymentStatus: "pending",
      requestedTime: { $lt: new Date(Date.now() - STALE_AFTER_MS) },
    },
    { status: "cancelled", cancelledBy: "system", cancelReason: "Time expired" }
  );
}

function loadFull(id) {
  return Booking.findById(id)
    .populate("customer", "name phone")
    .populate({ path: "salon", populate: { path: "owner", select: "name phone" } });
}

async function doRefund(booking) {
  const payId = booking.razorpayPaymentId;
  if (!payId || String(payId).startsWith("COUPON-")) {
    return { ok: true, message: "No fee was charged (coupon used), so no refund is needed." };
  }
  try {
    const refund = await refundPayment(payId, booking.platformFee || PLATFORM_FEE);
    booking.paymentStatus = "refunded";
    booking.refundId = refund.id;
    booking.refundedAt = new Date();
    await booking.save();
    return { ok: true, message: "The ₹15 refund has been started. It will reach you in 5-7 working days." };
  } catch (err) {
    console.error("REFUND FAILED for booking", String(booking._id), err && (err.error || err.message || err));
    booking.paymentStatus = "refund_failed";
    await booking.save();
    return { ok: false, message: "There was an issue with the refund. We'll refund it manually soon — email salonwale2@gmail.com." };
  }
}

function tell(booking, who, line) {
  try {
    const salon = booking.salon;
    if (who === "owner") {
      const owner = salon && salon.owner;
      if (owner && owner.phone) wa.notifyOwner(owner.phone, owner.name, line);
    } else if (booking.customer && booking.customer.phone) {
      wa.notifyCustomer(booking.customer.phone, booking.customer.name, line);
    }
  } catch (e) { /* never break a booking because of a message */ }
}

function notifyConfirmed(b) {
  const t = wa.when(b.requestedTime);
  tell(b, "owner", `${b.customer.name}'s booking is confirmed: ${b.serviceName}, ${t}.`);
  tell(b, "customer", `Booking confirmed! ${b.salon.shopName}, ${b.serviceName}, ${t}. Address: ${b.salon.address}, ${b.salon.area}. You can view the map in the app.`);
}

function customerView(b) {
  const o = b.toObject();
  const confirmed = o.status === "accepted" && o.paymentStatus === "paid";
  const salon = o.salon || {};
  o.salon = {
    _id: salon._id,
    shopName: salon.shopName,
    address: salon.address,
    area: salon.area,
    city: salon.city,
    photoUrl: salon.photoUrl,
    location: salon.location,
    ownerPhone: confirmed && salon.owner ? salon.owner.phone : undefined,
  };
  return o;
}

router.post("/request", protect, wrap(async (req, res) => {
  if (req.user.role !== "customer") return res.status(403).json({ message: "Only customers can make bookings" });

  const { salonId, serviceName } = req.body;
  if (!isObjectId(salonId)) return res.status(400).json({ message: "Invalid salon" });

  const when = new Date(req.body.requestedTime);
  if (isNaN(when.getTime())) return res.status(400).json({ message: "Choose a valid time" });
  if (when.getTime() < Date.now() - 5 * 60 * 1000) return res.status(400).json({ message: "This time has passed, choose a later time" });
  if (when.getTime() > Date.now() + 60 * 24 * 3600 * 1000) return res.status(400).json({ message: "Bookings can't be made more than 60 days ahead" });

  const salon = await Salon.findById(salonId).populate("owner", "name phone");
  if (!salon || !isSubscriptionActive(salon)) {
    return res.status(400).json({ message: "This salon is not currently available" });
  }

  const service = salon.services.find((s) => s.name === serviceName);
  if (!service) return res.status(400).json({ message: "This service is not offered by this salon" });

  const active = await Booking.countDocuments({
    customer: req.user.id,
    $or: [{ status: "pending" }, { status: "accepted", paymentStatus: "pending" }],
    requestedTime: { $gte: new Date(Date.now() - STALE_AFTER_MS) },
  });
  if (active >= MAX_ACTIVE_REQUESTS) {
    return res.status(400).json({ message: "You already have 5 pending requests. Please wait for a reply." });
  }

  const duplicate = await Booking.findOne({
    customer: req.user.id, salon: salonId, requestedTime: when, status: { $in: ["pending", "accepted"] },
  });
  if (duplicate) return res.status(400).json({ message: "You've already sent a request for this time" });

  const booking = await Booking.create({
    customer: req.user.id,
    salon: salonId,
    serviceName: service.name,
    servicePrice: service.price,
    requestedTime: when,
    status: "pending",
  });

  const me = await User.findById(req.user.id).select("name");
  if (salon.owner && salon.owner.phone) {
    wa.notifyOwner(
      salon.owner.phone, salon.owner.name,
      `${me ? me.name : "A customer"} sent a request for ${service.name} (₹${service.price}) at ${wa.when(when)}. Open the app to Accept or Decline.`
    );
  }

  res.status(201).json(booking);
}));

router.get("/my-bookings", protect, wrap(async (req, res) => {
  await expireStale({ customer: req.user.id });
  const bookings = await Booking.find({ customer: req.user.id })
    .populate({
      path: "salon",
      select: "shopName address area city photoUrl location owner",
      populate: { path: "owner", select: "phone" },
    })
    .sort({ createdAt: -1 })
    .limit(100);
  res.json(bookings.map(customerView));
}));

router.patch("/:id/customer-cancel", protect, wrap(async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(404).json({ message: "Booking not found" });
  const booking = await loadFull(req.params.id);
  if (!booking || String(booking.customer._id) !== req.user.id) return res.status(403).json({ message: "Not authorized" });
  if (booking.status === "cancelled" || booking.status === "rejected") return res.status(400).json({ message: "This booking is already closed" });

  booking.status = "cancelled";
  booking.cancelledBy = "customer";
  booking.cancelReason = cleanText(req.body.reason, 100);
  await booking.save();

  tell(booking, "owner", `${booking.customer.name} cancelled their booking for ${booking.serviceName} (${wa.when(booking.requestedTime)}).`);
  res.json(booking);
}));

router.post("/:id/create-payment-order", protect, codeLimiter, wrap(async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(404).json({ message: "Booking not found" });
  const booking = await loadFull(req.params.id);
  if (!booking || String(booking.customer._id) !== req.user.id) {
    return res.status(403).json({ message: "Not authorized" });
  }
  if (booking.status !== "accepted") return res.status(400).json({ message: "This booking hasn't been accepted yet" });
  if (booking.paymentStatus === "paid") return res.status(400).json({ message: "Already paid" });

  const couponCode = cleanText(req.body.couponCode, 20).toUpperCase();
  if (couponCode === FREE_COUPON) {
    booking.paymentStatus = "paid";
    booking.razorpayPaymentId = `COUPON-${FREE_COUPON}`;
    await booking.save();
    notifyConfirmed(booking);
    return res.json({ free: true, message: "Booking confirmed for free with your coupon!" });
  }

  const order = await createOrder(PLATFORM_FEE, `booking_${booking._id}_${Date.now()}`);
  booking.razorpayOrderId = order.id;
  await booking.save();

  res.json({ order, key: process.env.RAZORPAY_KEY_ID, bookingId: booking._id });
}));

router.post("/:id/verify-payment", protect, wrap(async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(404).json({ message: "Booking not found" });
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  if (!verifySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
    return res.status(400).json({ message: "Payment could not be verified" });
  }

  const booking = await loadFull(req.params.id);
  if (!booking || String(booking.customer._id) !== req.user.id) return res.status(403).json({ message: "Not authorized" });
  if (booking.razorpayOrderId !== razorpay_order_id) return res.status(400).json({ message: "This payment doesn't belong to this booking" });
  if (booking.paymentStatus === "paid") return res.json({ message: "Payment confirmed", booking });

  const updated = await Booking.findOneAndUpdate(
    { _id: booking._id, status: "accepted", paymentStatus: "pending" },
    { paymentStatus: "paid", razorpayPaymentId: razorpay_payment_id },
    { new: true }
  );

  if (!updated) {
    booking.razorpayPaymentId = razorpay_payment_id;
    const r = await doRefund(booking);
    return res.status(409).json({ message: `The salon cancelled the booking in the meantime. ${r.message}` });
  }

  booking.paymentStatus = "paid";
  booking.razorpayPaymentId = razorpay_payment_id;
  notifyConfirmed(booking);

  res.json({ message: "Payment confirmed", booking });
}));

router.get("/salon/:salonId", protect, wrap(async (req, res) => {
  if (!isObjectId(req.params.salonId)) return res.status(404).json({ message: "Salon not found" });
  const salon = await Salon.findById(req.params.salonId);
  if (!salon || String(salon.owner) !== req.user.id) {
    return res.status(403).json({ message: "Not authorized for this salon" });
  }
  await expireStale({ salon: req.params.salonId });
  const bookings = await Booking.find({ salon: req.params.salonId })
    .populate("customer", "name phone")
    .sort({ createdAt: -1 })
    .limit(300);
  res.json(bookings);
}));

async function loadOwnedBooking(bookingId, userId) {
  if (!isObjectId(bookingId)) return { error: "Booking not found" };
  const booking = await loadFull(bookingId);
  if (!booking) return { error: "Booking not found" };
  if (String(booking.salon.owner._id) !== userId) return { error: "Not authorized" };
  return { booking };
}

router.patch("/:id/accept", protect, wrap(async (req, res) => {
  const { booking, error } = await loadOwnedBooking(req.params.id, req.user.id);
  if (error) return res.status(403).json({ message: error });
  if (booking.status !== "pending") return res.status(400).json({ message: "This request is no longer pending" });

  booking.status = "accepted";
  await booking.save();

  tell(booking, "customer", `${booking.salon.shopName} accepted your request for ${booking.serviceName} (${wa.when(booking.requestedTime)}). Pay the ₹15 fee in the app to confirm your booking.`);
  res.json(booking);
}));

router.patch("/:id/reject", protect, wrap(async (req, res) => {
  const { booking, error } = await loadOwnedBooking(req.params.id, req.user.id);
  if (error) return res.status(403).json({ message: error });
  if (booking.status !== "pending") return res.status(400).json({ message: "This request is no longer pending" });

  booking.status = "rejected";
  booking.rejectionNote = cleanText(req.body.note, 100);
  await booking.save();

  tell(booking, "customer", `${booking.salon.shopName} can't take your ${booking.serviceName} request right now.${booking.rejectionNote ? " Salon's note: " + booking.rejectionNote : " Please try a different time."}`);
  res.json(booking);
}));

router.patch("/:id/cancel", protect, wrap(async (req, res) => {
  const { booking, error } = await loadOwnedBooking(req.params.id, req.user.id);
  if (error) return res.status(403).json({ message: error });
  if (booking.status !== "accepted" && booking.status !== "pending") {
    return res.status(400).json({ message: "This booking is already closed" });
  }

  const reason = cleanText(req.body.reason || req.body.note, 100);

  const claimed = await Booking.findOneAndUpdate(
    { _id: booking._id, status: { $in: ["pending", "accepted"] } },
    { status: "cancelled", cancelledBy: "owner", cancelReason: reason },
    { new: true }
  );
  if (!claimed) return res.status(400).json({ message: "This booking is already closed" });

  booking.status = "cancelled";
  booking.cancelledBy = "owner";
  booking.cancelReason = reason;
  booking.paymentStatus = claimed.paymentStatus;
  booking.razorpayPaymentId = claimed.razorpayPaymentId;
  const wasPaid = claimed.paymentStatus === "paid";

  let refund = null;
  if (wasPaid) refund = await doRefund(booking);

  tell(
    booking, "customer",
    `${booking.salon.shopName} cancelled your booking (${booking.serviceName}, ${wa.when(booking.requestedTime)}).${wasPaid && refund && refund.ok ? " Your ₹15 fee is being refunded (5-7 days)." : ""}`
  );

  res.json({ booking, refund });
}));

router.post("/:id/retry-refund", protect, wrap(async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(404).json({ message: "Booking not found" });
  const booking = await loadFull(req.params.id);
  if (!booking) return res.status(404).json({ message: "Booking not found" });
  const isCustomer = String(booking.customer._id) === req.user.id;
  const isOwner = String(booking.salon.owner._id) === req.user.id;
  if (!isCustomer && !isOwner) return res.status(403).json({ message: "Not authorized" });
  if (booking.paymentStatus !== "refund_failed") return res.status(400).json({ message: "This booking has no pending refund" });
  if (booking.cancelledBy === "customer") return res.status(400).json({ message: "No refund applies when the customer cancels" });

  const refund = await doRefund(booking);
  res.status(refund.ok ? 200 : 502).json({ booking, refund });
}));

module.exports = router;
