const mongoose = require("mongoose");

const bookingSchema = new mongoose.Schema(
  {
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    salon: { type: mongoose.Schema.Types.ObjectId, ref: "Salon", required: true },
    serviceName: { type: String, required: true },
    servicePrice: { type: Number, required: true }, // customer pays this AT the salon, not to platform
    bookingTime: { type: Date, required: true }, // jab customer aayega

    // Platform fee (₹15) — ye customer humein pay karta hai booking ke time
    platformFee: { type: Number, default: 15 },
    paymentStatus: { type: String, enum: ["pending", "paid", "failed"], default: "pending" },
    razorpayOrderId: { type: String },
    razorpayPaymentId: { type: String },

    status: {
      type: String,
      enum: ["confirmed", "completed", "cancelled"],
      default: "confirmed",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Booking", bookingSchema);
