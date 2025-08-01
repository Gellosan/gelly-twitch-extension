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
});
const Gelly = mongoose.models.Gelly || mongoose.model("Gelly", GellySchema);

// ===== Express Setup =====
const app = express();
app.use(express.json());

// ===== Flexible Twitch CORS =====
const allowedRegexes = [/\.ext-twitch\.tv$/, /\.twitch\.tv$/];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true); // Allow server-to-server calls

      try {
        const hostname = new URL(origin).hostname;
        if (
          allowedRegexes.some((rx) => rx.test(hostname)) ||
          hostname === "localhost" ||
          hostname === "127.0.0.1"
        ) {
          return callback(null, true);
        }
      } catch (err) {
        console.warn("CORS parse error:", err);
      }

      console.warn(`🚫 CORS blocked origin: ${origin}`);
      callback(new Error("CORS not allowed"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

// Explicit OPTIONS preflight handler
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
    } else {
      console.warn("⚠️ WebSocket connection without userId");
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

// ===== Interact Endpoint =====
app.post("/v1/interact", async (req, res) => {
  console.log("📥 /v1/interact hit:", req.body);

  try {
    const { user, action } = req.body;
    if (!user) return res.json({ success: false, message: "Missing user ID" });

    let gelly = await Gelly.findOne({ userId: user });
    if (!gelly) gelly = new Gelly({ userId: user, points: 0 });

    let pointsAwarded = 0;

    if (action.startsWith("color:")) {
      const color = action.split(":")[1];
      if (["blue", "green", "pink"].includes(color)) gelly.color = color;
      pointsAwarded = 1;
    } else {
      switch (action) {
        case "feed":
          gelly.energy = Math.min(100, gelly.energy + 10);
          pointsAwarded = 5;
          break;
        case "play":
          gelly.mood = Math.min(100, gelly.mood + 10);
          pointsAwarded = 5;
          break;
        case "clean":
          gelly.cleanliness = Math.min(100, gelly.cleanliness + 10);
          pointsAwarded = 5;
          break;
        default:
          return res.json({ success: false, message: "Unknown action" });
      }
    }

    gelly.points += pointsAwarded;

    if (gelly.stage === "egg" && gelly.energy >= 100) gelly.stage = "blob";
    if (gelly.stage === "blob" && gelly.mood >= 100 && gelly.cleanliness >= 100) gelly.stage = "gelly";

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
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
