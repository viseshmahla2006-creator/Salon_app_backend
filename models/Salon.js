const mongoose = require("mongoose");

const serviceSchema = new mongoose.Schema({
  name: { type: String, required: true }, // e.g. "Hair Cut", "Beard Trim"
  price: { type: Number, required: true },
});

const salonSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    shopName: { type: String, required: true },
    city: { type: String, required: true },
    area: { type: String, required: true }, // localized area/mohalla for filtering
    address: { type: String, required: true },
    photoUrl: { type: String, default: "" },
    services: [serviceSchema],
    openTime: { type: String, default: "10:00" },
    closeTime: { type: String, default: "20:00" },

    // Subscription - salon owner pays ₹199/month to stay listed
    subscriptionActive: { type: Boolean, default: false },
    subscriptionExpiresAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Salon", salonSchema);
