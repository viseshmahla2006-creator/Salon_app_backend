require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const connectDB = require("./config/db");
const { securityHeaders, sanitizeInput, rateLimit } = require("./utils/security");

const authRoutes = require("./routes/auth");
const dhunRoutes = require("./routes/dhun");
const salonRoutes = require("./routes/salons");
const bookingRoutes = require("./routes/bookings");
const couponRoutes = require("./routes/coupons");
const socialRoutes = require("./routes/social");
const ttsRoutes = require("./routes/tts");

const app = express();

// Render sits behind a proxy — needed so rate limits see the real visitor IP
app.set("trust proxy", 1);

app.use(securityHeaders);
app.use(cors());
app.use(express.json({ limit: "12mb" })); // photos can be base64 until Cloudinary is set up
app.use(sanitizeInput);

// General safety net: 1500 requests / 15 min per IP (app polls every ~10s, and many phones share an IP)
app.use("/api", rateLimit({ windowMs: 15 * 60 * 1000, max: 1500 }));

connectDB();

app.get("/", (req, res) => res.send("Salon Booking API is running ✅"));
app.get("/health", (req, res) => res.json({ ok: true })); // ping this from UptimeRobot to avoid cold starts
app.get("/sorry", (req, res) => res.sendFile(path.join(__dirname, "sorry.html")));
app.get("/busy", (req, res) => res.sendFile(path.join(__dirname, "busy.html")));
app.get("/devi", (req, res) => res.sendFile(path.join(__dirname, "devi.html")));
app.get("/devi-video.mp4", (req, res) => {
  try {
    let b64 = "";
    for (let i = 1; i <= 22; i++) {
      const n = String(i).padStart(2, "0");
      b64 += fs.readFileSync(path.join(__dirname, "gf-vid-" + n + ".txt"), "utf8").trim();
    }
    const buf = Buffer.from(b64, "base64");
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", buf.length);
    res.setHeader("Accept-Ranges", "bytes");
    res.send(buf);
  } catch (e) { res.status(404).send("Video not found"); }
});
app.get("/devi-assets/:file", (req, res) => { if (!/^gf-vid-\d+\.txt$/.test(req.params.file)) return res.status(404).send("Not found"); res.sendFile(path.join(__dirname, req.params.file)); }); // Devi video chunks only, same-origin

// Coupon check: tight limit so codes cannot be guessed
app.use("/api/coupons", rateLimit({ windowMs: 15 * 60 * 1000, max: 30 }), couponRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/dhun", dhunRoutes); // Dhun music app accounts (email+OTP)
app.use("/api/tts", ttsRoutes); // Billu cat natural voice (SONIQ)
app.use("/api/salons", salonRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api", socialRoutes); // /reviews, /favorites, /reports

app.use("/api", (req, res) => res.status(404).json({ message: "Not found" }));

// Bad JSON / too-big photo etc.
app.use((err, req, res, next) => {
  if (err.type === "entity.too.large") return res.status(413).json({ message: "Photo or data is too large" });
  if (err.type === "entity.parse.failed") return res.status(400).json({ message: "Invalid request" });
  console.error("UNHANDLED", err);
  res.status(500).json({ message: "Server error, please try again" });
});

process.on("unhandledRejection", (err) => console.error("UNHANDLED REJECTION", err));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server is running on port ${PORT}`));
