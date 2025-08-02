const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const WebSocket = require("ws");
const fetch = require("node-fetch");
require("dotenv").config();

// ===== MongoDB Connection =====
mongoose
  .connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ Mongo Error:", err));

// ===== Gelly Model =====
const GellySchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  displayName: String,
  energy: { type: Number, default: 100 },
  mood: { type: Number, default: 50 },
  cleanliness: { type: Number, default: 50 },
  stage: { type: String, default: "egg" },
  color: { type: String, default: "blue" },
  points: { type: Number, default: 0 },
  lastUpdated: { type: Date, default: Date.now },
  cooldowns: { type: Object, default: {} }, // per-action cooldown timestamps
});
const Gelly = mongoose.models.Gelly || mongoose.model("Gelly", GellySchema);

// ===== Express Setup =====
const app = express();
app.use(express.json());

// CORS
app.use(
  cors({
    origin: (origin, callback) => {
      try {
        if (!origin) return callback(null, true);
        const hostname = new URL(origin).hostname;
        if (
          /\.ext-twitch\.tv$/.test(hostname) ||
          /\.twitch\.tv$/.test(hostname) ||
          hostname === "localhost" ||
          hostname === "127.0.0.1"
        ) {
          return callback(null, true);
        }
      } catch (_) {}
      console.warn(`🚫 CORS blocked origin: ${origin}`);
      callback(new Error("CORS not allowed"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);
app.options("*", cors());

// ===== WebSocket Setup =====
const server = require("http").createServer(app);
const wss = new WebSocket.Server({ server });
const clients = new Map();

wss.on("connection", (ws, req) => {
  try {
    const searchParams = new URL(req.url, `http://${req.headers.host}`).searchParams;
    const userId = searchParams.get("user");

    if (userId) {
      clients.set(userId, ws);
      console.log(`🔌 WebSocket connected for user: ${userId}`);
    }

    ws.on("close", () => {
      if (userId) {
        clients.delete(userId);
        console.log(`❌ WebSocket disconnected for user: ${userId}`);
      }
    });

    ws.on("error", (err) => {
      console.error(`🚨 WebSocket error for user: ${userId}`, err);
    });
  } catch (e) {
    console.error("🚨 Error in WebSocket handler:", e);
  }
});

function broadcastState(userId, gelly) {
  const ws = clients.get(userId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "update", state: gelly }));
  }
}

async function sendLeaderboard() {
  const leaderboard = await Gelly.find()
    .sort({ points: -1, mood: -1, energy: -1, cleanliness: -1 })
    .limit(10)
    .lean();

  const data = JSON.stringify({ type: "leaderboard", entries: leaderboard });
  for (const [, ws] of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

// ===== StreamElements API =====
const STREAM_ELEMENTS_JWT = "YOUR_STREAM_ELEMENTS_JWT_HERE"; // replace with your JWT
const STREAM_ELEMENTS_BASE = "https://api.streamelements.com/kappa/v2";

async function getJellybeans(userId) {
  const res = await fetch(`${STREAM_ELEMENTS_BASE}/points/${process.env.STREAMELEMENTS_CHANNEL_ID}/${userId}`, {
    headers: { Authorization: `Bearer ${STREAM_ELEMENTS_JWT}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.points || 0;
}

async function deductJellybeans(userId, amount) {
  return fetch(`${STREAM_ELEMENTS_BASE}/points/${process.env.STREAMELEMENTS_CHANNEL_ID}/${userId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${STREAM_ELEMENTS_JWT}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ points: -Math.abs(amount) }),
  });
}

// ===== Interact Endpoint =====
app.post("/v1/interact", async (req, res) => {
  try {
    const { user, action } = req.body;
    if (!user) return res.json({ success: false, message: "Missing user ID" });

    let gelly = await Gelly.findOne({ userId: user });
    if (!gelly) gelly = new Gelly({ userId: user, points: 0 });

    // Cooldown check (per action)
    const now = Date.now();
    const cooldown = 60000; // 60 seconds
    if (gelly.cooldowns[action] && now - gelly.cooldowns[action] < cooldown) {
      const remaining = Math.ceil((cooldown - (now - gelly.cooldowns[action])) / 1000);
      return res.json({ success: false, message: `Cooldown active`, cooldown: remaining });
    }

    // Feed action costs jellybeans
    if (action === "feed") {
      const jellybeans = await getJellybeans(user);
      if (jellybeans < 1000) {
        return res.json({ success: false, message: "Not enough jellybeans" });
      }
      await deductJellybeans(user, 1000);
    }

    // Action effects (max values increased for slower growth)
    switch (action) {
      case "feed":
        gelly.energy = Math.min(300, gelly.energy + 10);
        gelly.points += 5;
        break;
      case "play":
        gelly.mood = Math.min(300, gelly.mood + 10);
        gelly.points += 5;
        break;
      case "clean":
        gelly.cleanliness = Math.min(300, gelly.cleanliness + 10);
        gelly.points += 5;
        break;
      default:
        return res.json({ success: false, message: "Unknown action" });
    }

    // Stage progression
    if (gelly.stage === "egg" && gelly.energy >= 150) gelly.stage = "blob";
    if (gelly.stage === "blob" && gelly.mood >= 200 && gelly.cleanliness >= 200) gelly.stage = "gelly";

    gelly.cooldowns[action] = now;
    gelly.lastUpdated = new Date();
    await gelly.save();

    broadcastState(user, gelly);
    sendLeaderboard();

    res.json({ success: true, cooldown: 60 });
  } catch (err) {
    console.error("❌ Error in /v1/interact:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
