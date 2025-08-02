// server.js
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const WebSocket = require("ws");
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
  lastActionTimes: {
    feed: { type: Date, default: new Date(0) },
    play: { type: Date, default: new Date(0) },
    clean: { type: Date, default: new Date(0) },
    colorChange: { type: Date, default: new Date(0) },
  },
});
const Gelly = mongoose.models.Gelly || mongoose.model("Gelly", GellySchema);

// ===== Express Setup =====
const app = express();
app.use(express.json());

app.use(
  cors({
    origin: (origin, callback) => {
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

// ===== STREAM ELEMENTS HELPERS =====
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const STREAM_ELEMENTS_API = "https://api.streamelements.com/kappa/v2/points";
const STREAM_ELEMENTS_JWT = process.env.STREAMELEMENTS_JWT;
const STREAM_ELEMENTS_CHANNEL_ID = process.env.STREAMELEMENTS_CHANNEL_ID;

async function getUserPoints(username) {
  try {
    const url = `${STREAM_ELEMENTS_API}/${STREAM_ELEMENTS_CHANNEL_ID}/${encodeURIComponent(username)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${STREAM_ELEMENTS_JWT}` },
    });

    if (!res.ok) {
      console.error(`StreamElements API error (${res.status}):`, await res.text());
      return 0;
    }

    const data = await res.json();
    return data?.points || 0;
  } catch (err) {
    console.error("❌ getUserPoints error:", err);
    return 0;
  }
}

async function deductUserPoints(username, amount) {
  try {
    const url = `${STREAM_ELEMENTS_API}/${STREAM_ELEMENTS_CHANNEL_ID}/${encodeURIComponent(username)}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${STREAM_ELEMENTS_JWT}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ points: -Math.abs(amount) }),
    });

    if (!res.ok) {
      console.error(`StreamElements API error (${res.status}):`, await res.text());
    }
  } catch (err) {
    console.error("❌ deductUserPoints error:", err);
  }
}

// ===== Interact Endpoint =====
app.post("/v1/interact", async (req, res) => {
  try {
    const { user, username, action } = req.body; // Now expecting Twitch display name
    if (!user || !username) {
      return res.json({ success: false, message: "Missing user or username" });
    }

    let gelly = await Gelly.findOne({ userId: user });
    if (!gelly) gelly = new Gelly({ userId: user, displayName: username, points: 0 });

    // Per-action cooldown (60s)
    const now = new Date();
    if (gelly.lastActionTimes[action] && now - gelly.lastActionTimes[action] < 60000) {
      return res.json({ success: false, message: "That action is on cooldown." });
    }

    let pointsAwarded = 0;

    if (action.startsWith("color:")) {
      const color = action.split(":")[1];
      const userPoints = await getUserPoints(username);
      if (userPoints < 10000) {
        return res.json({ success: false, message: "Not enough Jellybeans for color change." });
      }
      await deductUserPoints(username, 10000);
      gelly.color = color;
      pointsAwarded = 1;
    } else {
      switch (action) {
        case "feed":
          const feedPoints = await getUserPoints(username);
          if (feedPoints < 1000) {
            return res.json({ success: false, message: "Not enough Jellybeans to feed." });
          }
          await deductUserPoints(username, 1000);
          gelly.energy = Math.min(500, gelly.energy + 20);
          pointsAwarded = 5;
          break;
        case "play":
          gelly.mood = Math.min(500, gelly.mood + 20);
          pointsAwarded = 5;
          break;
        case "clean":
          gelly.cleanliness = Math.min(500, gelly.cleanliness + 20);
          pointsAwarded = 5;
          break;
        default:
          return res.json({ success: false, message: "Unknown action" });
      }
    }

    // Growth logic
    if (gelly.stage === "egg" && gelly.energy >= 200) gelly.stage = "blob";
    if (gelly.stage === "blob" && gelly.mood >= 400 && gelly.cleanliness >= 400)
      gelly.stage = "gelly";

    gelly.points += pointsAwarded;
    gelly.lastUpdated = now;
    gelly.lastActionTimes[action] = now;
    await gelly.save();

    broadcastState(user, gelly);
    sendLeaderboard();

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Error in /v1/interact:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

