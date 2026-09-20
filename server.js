require("dotenv").config();
const express = require("express");
const cors = require("cors");
const connectDB = require("./config/db");

const authRoutes = require("./routes/auth");
const salonRoutes = require("./routes/salons");
const bookingRoutes = require("./routes/bookings");
const couponRoutes = require("./routes/coupons");

const app = express();

app.use(cors());
app.use(express.json({ limit: "12mb" }));

connectDB();

app.get("/", (req, res) => {
  res.send("Salon Booking API is running ✅");
});

app.use("/api/auth", authRoutes);
app.use("/api/salons", salonRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/coupons", couponRoutes);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server is running on port ${PORT}`));
