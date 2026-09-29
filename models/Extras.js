// Review, Favorite and Report models in one file
const mongoose = require("mongoose");

const reviewSchema = new mongoose.Schema(
  {
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    salon: { type: mongoose.Schema.Types.ObjectId, ref: "Salon", required: true },
    booking: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", required: true, unique: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, default: "" },
  },
  { timestamps: true }
);

const favoriteSchema = new mongoose.Schema(
  {
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    salon: { type: mongoose.Schema.Types.ObjectId, ref: "Salon", required: true },
  },
  { timestamps: true }
);
favoriteSchema.index({ customer: 1, salon: 1 }, { unique: true });

const reportSchema = new mongoose.Schema(
  {
    reporter: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    salon: { type: mongoose.Schema.Types.ObjectId, ref: "Salon", required: true },
    reason: { type: String, required: true },
    status: { type: String, enum: ["open", "reviewed"], default: "open" },
  },
  { timestamps: true }
);

module.exports = {
  Review: mongoose.model("Review", reviewSchema),
  Favorite: mongoose.model("Favorite", favoriteSchema),
  Report: mongoose.model("Report", reportSchema),
};
