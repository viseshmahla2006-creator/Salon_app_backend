require("dotenv").config();
const express = require("express");
const cors = require("cors");
const connectDB = require("./config/db");
const { securityHeaders, sanitizeInput, rateLimit } = require("./utils/security");

const authRoutes = require("./routes/auth");
const salonRoutes = require("./routes/salons");
const bookingRoutes = require("./routes/bookings");
const couponRoutes = require("./routes/coupons");
const socialRoutes = require("./routes/social");

const app = express();

app.set("trust proxy", 1);

app.use(securityHeaders);
app.use(cors());
app.use(express.json({ limit: "12mb" }));
app.use(sanitizeInput);

app.use("/api", rateLimit({ windowMs: 15 * 60 * 1000, max: 1500 }));

connectDB();

app.get("/", (req, res) => res.send("Salon Booking API is running ✅"));
app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/api/coupons", rateLimit({ windowMs: 15 * 60 * 1000, max: 30 }), couponRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/salons", salonRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api", socialRoutes);

app.use("/api", (req, res) => res.status(404).json({ message: "Not found" }));

app.use((err, req, res, next) => {
  if (err.type === "entity.too.large") return res.status(413).json({ message: "Photo or data is too large" });
  if (err.type === "entity.parse.failed") return res.status(400).json({ message: "Invalid request" });
  console.error("UNHANDLED", err);
  res.status(500).json({ message: "Server error, please try again" });
});

process.on("unhandledRejection", (err) => console.error("UNHANDLED REJECTION", err));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server is running on port ${PORT}`));
