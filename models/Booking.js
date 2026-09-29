const mongoose = require("mongoose");

const bookingSchema = new mongoose.Schema(
  {
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    salon: { type: mongoose.Schema.Types.ObjectId, ref: "Salon", required: true },
    serviceName: { type: String, required: true },
    servicePrice: { type: Number, required: true }, // paid directly to the salon, not to the platform
    requestedTime: { type: Date, required: true },

    // pending -> owner hasn't responded yet
    // accepted -> owner said yes, waiting for customer to pay the platform fee
    // rejected -> owner said they can't take this slot
    // cancelled -> withdrawn by owner or customer (or the time passed unpaid)
    status: {
      type: String,
      enum: ["pending", "accepted", "rejected", "cancelled"],
      default: "pending",
    },
    rejectionNote: { type: String, default: "" },

    // Platform fee (₹15), paid only after the owner accepts
    platformFee: { type: Number, default: 15 },
    paymentStatus: { type: String, enum: ["pending", "paid", "refunded", "refund_failed"], default: "pending" },
    razorpayOrderId: { type: String },
    razorpayPaymentId: { type: String },

    // Cancellation + refund tracking
    cancelledBy: { type: String, enum: ["owner", "customer", "system", ""], default: "" },
    cancelReason: { type: String, default: "" },
    refundId: { type: String },
    refundedAt: { type: Date },

    reviewed: { type: Boolean, default: false },
  },
  { timestamps: true }
);

bookingSchema.index({ customer: 1, createdAt: -1 });
bookingSchema.index({ salon: 1, createdAt: -1 });

module.exports = mongoose.model("Booking", bookingSchema);
