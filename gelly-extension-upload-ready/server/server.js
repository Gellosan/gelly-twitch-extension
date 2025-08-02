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
  lastActionTimes: { type: Object, default: {} }, // cooldowns per action
});
const Gelly = mongoose.models.Gelly || mongoose.model("Gelly", GellySchema);

// ===== Express Setup =====
const app = express();
app.use(express.json());

// ===== Twitch CORS =====
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

// ===== StreamElements API Setup =====
const STREAM_ELEMENTS_API_KEY = "YOUR_HARDCODED_KEY_HERE"; // Replace with your actual API key
const STREAM_ELEMENTS_CHANNEL_ID = "YOUR_CHANNEL_ID_HERE"; // Replace with your channel ID

async function getUserPoints(userId) {
  const url = `https://api.streamelements.com/kappa/v2/points/${STREAM_ELEMENTS_CHANNEL_ID}/${userId}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${STREAM_ELEMENTS_API_KEY}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.points;
}

async function updateUserPoints(userId, amount) {
  const url = `https://api.streamelements.com/kappa/v2/points/${STREAM_ELEMENTS_CHANNEL_ID}/${userId}`;
  await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${STREAM_ELEMENTS_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ points: amount }),
  });
}

// ===== Interact Endpoint =====
app.post("/v1/interact", async (req, res) => {
  try {
    const { user, action } = req.body;
    if (!user) return res.json({ success: false, message: "Missing user ID" });

    let gelly = await Gelly.findOne({ userId: user });
    if (!gelly) gelly = new Gelly({ userId: user, points: 0 });

    // Cooldown per action type
    const now = Date.now();
    const lastActionTime = gelly.lastActionTimes[action] || 0;
    if (now - lastActionTime < 60000) {
      return res.json({ success: false, message: "Action on cooldown" });
    }

    let pointsAwarded = 0;

    if (action.startsWith("color:")) {
      const color = action.split(":")[1];
      const cost = 10000;

      const userPoints = await getUserPoints(user);
      if (userPoints === null || userPoints < cost) {
        return res.json({ success: false, message: "Not enough jellybeans" });
      }

      gelly.color = color;
      await updateUserPoints(user, userPoints - cost);

      pointsAwarded = 1;
    } else {
      switch (action) {
        case "feed": {
          const cost = 1000;
          const userPoints = await getUserPoints(user);
          if (userPoints === null || userPoints < cost) {
            return res.json({ success: false, message: "Not enough jellybeans" });
          }
          await updateUserPoints(user, userPoints - cost);
          gelly.energy = Math.min(1000, gelly.energy + 10);
          pointsAwarded = 5;
          break;
        }
        case "play":
          gelly.mood = Math.min(1000, gelly.mood + 10);
          pointsAwarded = 5;
          break;
        case "clean":
          gelly.cleanliness = Math.min(1000, gelly.cleanliness + 10);
          pointsAwarded = 5;
          break;
        default:
          return res.json({ success: false, message: "Unknown action" });
      }
    }

    gelly.points += pointsAwarded;

    // Stage progression
    if (gelly.stage === "egg" && gelly.energy >= 300) gelly.stage = "blob";
    if (gelly.stage === "blob" && gelly.mood >= 500 && gelly.cleanliness >= 500)
      gelly.stage = "gelly";

    gelly.lastUpdated = new Date();
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
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
