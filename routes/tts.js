// Billu (SONIQ cat) natural voice: neural Hindi TTS via Edge read-aloud
// voices (hi-IN-SwaraNeural, female). GET /api/tts?text=... -> audio/mpeg.
// Results cached in memory — Billu's lines repeat a lot.
const express = require("express");
const crypto = require("crypto");
const WebSocket = require("ws");

const router = express.Router();
const TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const VOICE = "hi-IN-SwaraNeural";
const cache = new Map();

function gec() {
  let ticks = (Math.floor(Date.now() / 1000) + 11644473600) * 10000000;
  ticks -= ticks % 3000000000;
  return crypto.createHash("sha256").update(ticks.toString() + TOKEN, "ascii")
    .digest("hex").toUpperCase();
}

function escapeXml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function synthesizeOnce(text, withGec) {
  return new Promise((resolve, reject) => {
    let url = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1"
      + "?TrustedClientToken=" + TOKEN;
    if (withGec) url += "&Sec-MS-GEC=" + gec() + "&Sec-MS-GEC-Version=1-130.0.2849.68";
    const ws = new WebSocket(url, {
      headers: {
        Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
        Cookie: "muid=" + crypto.randomBytes(16).toString("hex").toUpperCase(),
      },
    });
    const chunks = [];
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; clearTimeout(timer); try { ws.terminate(); } catch (_) {} reject(e); } };
    const timer = setTimeout(() => fail(new Error("tts timeout")), 20000);
    ws.on("open", () => {
      const ts = new Date().toUTCString();
      ws.send("X-Timestamp:" + ts + "\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n"
        + '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}');
      const ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='hi-IN'>"
        + "<voice name='" + VOICE + "'><prosody pitch='+0Hz' rate='+0%'>"
        + escapeXml(text) + "</prosody></voice></speak>";
      ws.send("X-RequestId:" + crypto.randomBytes(16).toString("hex")
        + "\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:" + ts + "\r\nPath:ssml\r\n\r\n" + ssml);
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        try {
          const headerLen = data.readUInt16BE(0);
          const header = data.subarray(2, 2 + headerLen).toString();
          if (header.includes("Path:audio")) chunks.push(data.subarray(2 + headerLen));
        } catch (_) {}
      } else if (data.toString().includes("turn.end")) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          try { ws.close(); } catch (_) {}
          if (chunks.length) resolve(Buffer.concat(chunks));
          else reject(new Error("empty audio"));
        }
      }
    });
    ws.on("error", fail);
    ws.on("close", () => { if (!settled && !chunks.length) fail(new Error("ws closed")); });
  });
}

async function synthesize(text) {
  try { return await synthesizeOnce(text, true); }
  catch (e) { return await synthesizeOnce(text, false); }
}

router.get("/warm", (req, res) => res.json({ ok: true }));

router.get("/", async (req, res) => {
  const text = ((req.query.text || "") + "").trim().slice(0, 300);
  if (!text) return res.status(400).json({ error: "text required" });
  const key = crypto.createHash("md5").update(text).digest("hex");
  if (cache.has(key)) {
    res.set("Content-Type", "audio/mpeg");
    return res.send(cache.get(key));
  }
  try {
    const audio = await synthesize(text);
    if (cache.size > 200) cache.clear();
    cache.set(key, audio);
    res.set("Content-Type", "audio/mpeg");
    res.send(audio);
  } catch (e) {
    console.error("TTS failed:", e.message);
    res.status(502).json({ error: "tts failed" });
  }
});

module.exports = router;
