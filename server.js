// BossCall standalone service — lets the BossCall app work end-to-end
// WITHOUT touching the production Salon backend.
// Mounts the BossCall routes (in-memory queue, X-Boss-Key auth) at
// /api/bosscall. Only env var needed: BOSSCALL_KEY.
const express = require("express");
const bosscallRoutes = require("./routes/bosscall");

const app = express();
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true, service: "bosscall" }));
app.get("/", (req, res) => res.send("BossCall service is running"));

app.use("/api/bosscall", bosscallRoutes);

// Unknown route
app.use((req, res) => res.status(404).json({ ok: false, message: "Not found" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`BossCall listening on ${PORT}`));
