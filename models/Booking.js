const mongoose = require("mongoose");

const bookingSchema = new mongoose.Schema(
  {
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    salon: { type: mongoose.Schema.Types.ObjectId, ref: "Salon", required: true },
    serviceName: { type: String, required: true },
    servicePrice: { type: Number, required: true },
    requestedTime: { type: Date, required: true },

    status: {
      type: String,
      enum: ["pending", "accepted", "rejected", "cancelled"],
      default: "pending",
    },
    rejectionNote: { type: String, default: "" },

    platformFee: { type: Number, default: 15 },
    paymentStatus: { type: String, enum: ["pending", "paid"], default: "pending" },
    razorpayOrderId: { type: String },
    razorpayPaymentId: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Booking", bookingSchema);
