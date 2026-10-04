const mongoose = require("mongoose");

async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ MongoDB connected");

    // Drop old indexes, keep only _id, phone and email
    try {
      const col = mongoose.connection.collection("users");
      const indexes = await col.indexes();
      for (const idx of indexes) {
        if (idx.name !== "_id_" && idx.name !== "phone_1" && idx.name !== "email_1") {
          await col.dropIndex(idx.name);
          console.log("🧹 Dropped old index:", idx.name);
        }
      }
    } catch (e) {
      console.log("Index cleanup skipped:", e.message);
    }
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err.message);
    process.exit(1);
  }
}

module.exports = connectDB;
