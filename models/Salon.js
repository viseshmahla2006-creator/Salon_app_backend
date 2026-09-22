const mongoose = require("mongoose");

const serviceSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },

  price: {
    type: Number,
    required: true,
  },

  icon: {
    type: String,
    default: "✂️",
  },
});

const salonSchema = new mongoose.Schema(
  {
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    shopName: {
      type: String,
      required: true,
    },

    city: {
      type: String,
      required: true,
    },

    area: {
      type: String,
      required: true,
    },

    address: {
      type: String,
      required: true,
    },

    photoUrl: {
      type: String,
      default: "",
    },

    galleryPhotos: {
      type: [String],
      default: [],
    },

    services: [serviceSchema],

    openTime: {
      type: String,
      default: "10:00",
    },

    closeTime: {
      type: String,
      default: "20:00",
    },

    isOpen: {
      type: Boolean,
      default: false,
    },

    availabilityNote: {
      type: String,
      default: "",
    },

    // ==========================================
    // OWNER SUBSCRIPTION
    // ==========================================

    subscriptionActive: {
      type: Boolean,
      default: false,
    },

    subscriptionStartedAt: {
      type: Date,
      default: null,
    },

    subscriptionExpiresAt: {
      type: Date,
      default: null,
    },

    // ==========================================
    // MKCC TEST ACCESS
    // ==========================================

    testAccessExpiresAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Salon", salonSchema);
