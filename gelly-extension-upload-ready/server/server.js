const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const WebSocket = require("ws");
require("dotenv").config();

const DECAY_RATE = 2; // points/hour decay
const DECAY_INTERVAL = 10 * 60 * 1000; // every 10 minutes
const MAX_STAT = 300;
const GLOBAL_COOLDOWN = 60 * 1000; // 60 seconds

mongoose
  .connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ Mongo Error:", err));

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
  lastActionTime: { type: Date, default: new Date(0) }
});
const Gelly = mongoose.models.Gelly || mongoose.model("Gelly", GellySchema);

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
    credentials: true
  })
);
app.options("*", cors());

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

function applyDecay(gelly) {
  const now = Date.now();
  const hoursElapsed = (now - gelly.lastUpdated.getTime()) / (1000 * 60 * 60);
  const decayAmount = Math.floor(hoursElapsed * DECAY_RATE);

  if (decayAmount > 0) {
    gelly.energy = Math.max(0, gelly.energy - decayAmount);
    gelly.mood = Math.max(0, gelly.mood - decayAmount);
    gelly.cleanliness = Math.max(0, gelly.cleanliness - decayAmount);
    gelly.lastUpdated = new Date();
  }
}

setInterval(async () => {
  const gellys = await Gelly.find();
  for (let g of gellys) {
    applyDecay(g);
    await g.save();
    broadcastState(g.userId, g);
  }
  sendLeaderboard();
}, DECAY_INTERVAL);

app.post("/v1/interact", async (req, res) => {
  try {
    const { user, action } = req.body;
    if (!user) return res.json({ success: false, message: "Missing user ID" });

    let gelly = await Gelly.findOne({ userId: user });
    if (!gelly) gelly = new Gelly({ userId: user });

    applyDecay(gelly);

    const now = Date.now();
    if (now - new Date(gelly.lastActionTime).getTime() < GLOBAL_COOLDOWN) {
      return res.json({ success: false, message: "Please wait before interacting again." });
    }

    let pointsAwarded = 0;
    switch (action) {
      case "feed":
        gelly.energy = Math.min(MAX_STAT, gelly.energy + 10);
        pointsAwarded = 5;
        break;
      case "play":
        gelly.mood = Math.min(MAX_STAT, gelly.mood + 10);
        pointsAwarded = 5;
        break;
      case "clean":
        gelly.cleanliness = Math.min(MAX_STAT, gelly.cleanliness + 10);
        pointsAwarded = 5;
        break;
      default:
        return res.json({ success: false, message: "Unknown action" });
    }

    gelly.points += pointsAwarded;

    if (gelly.stage === "egg" && gelly.energy >= 200) gelly.stage = "blob";
    if (gelly.stage === "blob" && gelly.mood >= 250 && gelly.cleanliness >= 250) gelly.stage = "gelly";

    gelly.lastActionTime = new Date();
    gelly.lastUpdated = new Date();
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

