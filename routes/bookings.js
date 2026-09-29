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
const MAX_ACTIVE_REQUESTS = 5; // one customer can't spam salons with requests
const STALE_AFTER_MS = 30 * 60 * 1000; // unpaid/unanswered requests die 30 min after their slot time

const codeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });

// ---------- helpers ----------

// Requests whose time has passed without payment are cancelled automatically
async function expireStale(filter) {
  await Booking.updateMany(
    {
      ...filter,
      status: { $in: ["pending", "accepted"] },
      paymentStatus: "pending",
      requestedTime: { $lt: new Date(Date.now() - STALE_AFTER_MS) },
    },
    { status: "cancelled", cancelledBy: "system", cancelReason: "Time nikal gaya" }
  );
}

// Load a booking with customer + salon + salon owner (for notifications)
function loadFull(id) {
  return Booking.findById(id)
    .populate("customer", "name phone")
    .populate({ path: "salon", populate: { path: "owner", select: "name phone" } });
}

// Refund the ₹15 fee. Returns { ok, message }
async function doRefund(booking) {
  const payId = booking.razorpayPaymentId;
  if (!payId || String(payId).startsWith("COUPON-")) {
    return { ok: true, message: "Koi fee charge nahi hui thi (coupon), isliye refund ki zaroorat nahi." };
  }
  try {
    const refund = await refundPayment(payId, booking.platformFee || PLATFORM_FEE);
    booking.paymentStatus = "refunded";
    booking.refundId = refund.id;
    booking.refundedAt = new Date();
    await booking.save();
    return { ok: true, message: "₹15 ka refund shuru ho gaya hai. 5-7 working days mein paisa wapas aa jayega." };
  } catch (err) {
    console.error("REFUND FAILED for booking", String(booking._id), err && (err.error || err.message || err));
    booking.paymentStatus = "refund_failed";
    await booking.save();
    return { ok: false, message: "Refund mein dikkat aayi. Hum jaldi manually wapas kar denge — salonwale2@gmail.com par likhein." };
  }
}

// Fire-and-forget WhatsApp messages
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
  tell(b, "owner", `${b.customer.name} ki booking confirm ho gayi: ${b.serviceName}, ${t}.`);
  tell(b, "customer", `Booking confirm! ${b.salon.shopName}, ${b.serviceName}, ${t}. Address: ${b.salon.address}, ${b.salon.area}. App mein map dekh sakte hain.`);
}

// What a customer gets to see (owner phone only after the booking is confirmed)
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

// ---------- CUSTOMER ----------

// Send a booking request (no payment yet — that happens only after acceptance)
router.post("/request", protect, wrap(async (req, res) => {
  if (req.user.role !== "customer") return res.status(403).json({ message: "Sirf customers booking kar sakte hain" });

  const { salonId, serviceName } = req.body;
  if (!isObjectId(salonId)) return res.status(400).json({ message: "Invalid salon" });

  const when = new Date(req.body.requestedTime);
  if (isNaN(when.getTime())) return res.status(400).json({ message: "Sahi time chunein" });
  if (when.getTime() < Date.now() - 5 * 60 * 1000) return res.status(400).json({ message: "Ye time nikal chuka hai, aage ka time chunein" });
  if (when.getTime() > Date.now() + 60 * 24 * 3600 * 1000) return res.status(400).json({ message: "60 din se aage ki booking nahi ho sakti" });

  const salon = await Salon.findById(salonId).populate("owner", "name phone");
  if (!salon || !isSubscriptionActive(salon)) {
    return res.status(400).json({ message: "This salon is not currently available" });
  }

  // Price always comes from the salon's own list, never from the phone
  const service = salon.services.find((s) => s.name === serviceName);
  if (!service) return res.status(400).json({ message: "Ye service is salon mein nahi hai" });

  const active = await Booking.countDocuments({
    customer: req.user.id,
    $or: [{ status: "pending" }, { status: "accepted", paymentStatus: "pending" }],
    requestedTime: { $gte: new Date(Date.now() - STALE_AFTER_MS) },
  });
  if (active >= MAX_ACTIVE_REQUESTS) {
    return res.status(400).json({ message: "Aapke 5 requests pehle se pending hain. Unka jawab aane ka wait karein." });
  }

  const duplicate = await Booking.findOne({
    customer: req.user.id, salon: salonId, requestedTime: when, status: { $in: ["pending", "accepted"] },
  });
  if (duplicate) return res.status(400).json({ message: "Is time ke liye aapki request pehle se bheji hui hai" });

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
      `${me ? me.name : "Ek customer"} ne ${service.name} (₹${service.price}) ke liye ${wa.when(when)} ka request bheja hai. App kholkar Accept ya Decline karein.`
    );
  }

  res.status(201).json(booking);
}));

// See my requests/bookings
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

// Customer cancels their own booking (fee is NOT refunded once paid — see refund policy)
router.patch("/:id/customer-cancel", protect, wrap(async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(404).json({ message: "Booking not found" });
  const booking = await loadFull(req.params.id);
  if (!booking || String(booking.customer._id) !== req.user.id) return res.status(403).json({ message: "Not authorized" });
  if (booking.status === "cancelled" || booking.status === "rejected") return res.status(400).json({ message: "Ye booking pehle hi band ho chuki hai" });

  booking.status = "cancelled";
  booking.cancelledBy = "customer";
  booking.cancelReason = cleanText(req.body.reason, 100);
  await booking.save();

  tell(booking, "owner", `${booking.customer.name} ne ${booking.serviceName} ki booking (${wa.when(booking.requestedTime)}) cancel kar di hai.`);
  res.json(booking);
}));

// Create a ₹15 Razorpay order — only allowed once the owner has accepted
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

// Verify payment for an accepted booking
router.post("/:id/verify-payment", protect, wrap(async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(404).json({ message: "Booking not found" });
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  if (!verifySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
    return res.status(400).json({ message: "Payment could not be verified" });
  }

  const booking = await loadFull(req.params.id);
  if (!booking || String(booking.customer._id) !== req.user.id) return res.status(403).json({ message: "Not authorized" });
  if (booking.razorpayOrderId !== razorpay_order_id) return res.status(400).json({ message: "Ye payment is booking ki nahi hai" });
  if (booking.paymentStatus === "paid") return res.json({ message: "Payment confirmed", booking });

  // Mark paid ONLY if the booking is still accepted (atomic, so it can't clash with an owner cancel)
  const updated = await Booking.findOneAndUpdate(
    { _id: booking._id, status: "accepted", paymentStatus: "pending" },
    { paymentStatus: "paid", razorpayPaymentId: razorpay_payment_id },
    { new: true }
  );

  if (!updated) {
    // Owner cancelled while the customer was paying -> give the money straight back
    booking.razorpayPaymentId = razorpay_payment_id;
    const r = await doRefund(booking);
    return res.status(409).json({ message: `Salon ne is beech booking cancel kar di. ${r.message}` });
  }

  booking.paymentStatus = "paid";
  booking.razorpayPaymentId = razorpay_payment_id;
  notifyConfirmed(booking);

  res.json({ message: "Payment confirmed", booking });
}));

// ---------- OWNER ----------

// See requests for my salon
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

// Accept a request (says "I'm free at this time")
router.patch("/:id/accept", protect, wrap(async (req, res) => {
  const { booking, error } = await loadOwnedBooking(req.params.id, req.user.id);
  if (error) return res.status(403).json({ message: error });
  if (booking.status !== "pending") return res.status(400).json({ message: "Ye request ab pending nahi hai" });

  booking.status = "accepted";
  await booking.save();

  tell(booking, "customer", `${booking.salon.shopName} ne aapka ${booking.serviceName} ka request accept kar liya hai (${wa.when(booking.requestedTime)}). Booking confirm karne ke liye app mein ₹15 fee pay karein.`);
  res.json(booking);
}));

// Reject a request (optionally say when they'll be free)
router.patch("/:id/reject", protect, wrap(async (req, res) => {
  const { booking, error } = await loadOwnedBooking(req.params.id, req.user.id);
  if (error) return res.status(403).json({ message: error });
  if (booking.status !== "pending") return res.status(400).json({ message: "Ye request ab pending nahi hai" });

  booking.status = "rejected";
  booking.rejectionNote = cleanText(req.body.note, 100);
  await booking.save();

  tell(booking, "customer", `${booking.salon.shopName} aapka ${booking.serviceName} ka request abhi nahi le sakta.${booking.rejectionNote ? " Salon ka note: " + booking.rejectionNote : " Kripya doosra time try karein."}`);
  res.json(booking);
}));

// Owner cancels: an unpaid accepted slot is freed; a PAID booking is cancelled AND refunded automatically
router.patch("/:id/cancel", protect, wrap(async (req, res) => {
  const { booking, error } = await loadOwnedBooking(req.params.id, req.user.id);
  if (error) return res.status(403).json({ message: error });
  if (booking.status !== "accepted" && booking.status !== "pending") {
    return res.status(400).json({ message: "Ye booking pehle hi band ho chuki hai" });
  }

  const reason = cleanText(req.body.reason || req.body.note, 100);

  // Claim the cancellation atomically so a double-tap can never refund twice
  const claimed = await Booking.findOneAndUpdate(
    { _id: booking._id, status: { $in: ["pending", "accepted"] } },
    { status: "cancelled", cancelledBy: "owner", cancelReason: reason },
    { new: true }
  );
  if (!claimed) return res.status(400).json({ message: "Ye booking pehle hi band ho chuki hai" });

  booking.status = "cancelled";
  booking.cancelledBy = "owner";
  booking.cancelReason = reason;
  booking.paymentStatus = claimed.paymentStatus;          // latest value (customer may have just paid)
  booking.razorpayPaymentId = claimed.razorpayPaymentId;
  const wasPaid = claimed.paymentStatus === "paid";

  let refund = null;
  if (wasPaid) refund = await doRefund(booking);

  tell(
    booking, "customer",
    `${booking.salon.shopName} ne aapki booking (${booking.serviceName}, ${wa.when(booking.requestedTime)}) cancel kar di hai.${wasPaid && refund && refund.ok ? " Aapki ₹15 fee wapas ki ja rahi hai (5-7 din)." : ""}`
  );

  res.json({ booking, refund });
}));

// Retry a refund that failed (owner or customer of that booking)
router.post("/:id/retry-refund", protect, wrap(async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(404).json({ message: "Booking not found" });
  const booking = await loadFull(req.params.id);
  if (!booking) return res.status(404).json({ message: "Booking not found" });
  const isCustomer = String(booking.customer._id) === req.user.id;
  const isOwner = String(booking.salon.owner._id) === req.user.id;
  if (!isCustomer && !isOwner) return res.status(403).json({ message: "Not authorized" });
  if (booking.paymentStatus !== "refund_failed") return res.status(400).json({ message: "Is booking ka refund pending nahi hai" });
  if (booking.cancelledBy === "customer") return res.status(400).json({ message: "Customer ke cancel par refund nahi hota" });

  const refund = await doRefund(booking);
  res.status(refund.ok ? 200 : 502).json({ booking, refund });
}));

module.exports = router;
