// server.js
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const WebSocket = require("ws");
require("dotenv").config();
const Gelly = require("./Gelly.js"); // <-- ensure Gelly model has applyDecay()

// ===== MongoDB Connection =====
mongoose
  .connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ Mongo Error:", err));

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

// ===== Twitch & StreamElements Helpers (unchanged from our last working version) =====
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_APP_ACCESS_TOKEN = process.env.TWITCH_APP_ACCESS_TOKEN;

async function fetchTwitchDisplayName(userId) {
  try {
    const res = await fetch(`https://api.twitch.tv/helix/users?id=${userId}`, {
      headers: {
        "Client-ID": TWITCH_CLIENT_ID,
        "Authorization": `Bearer ${TWITCH_APP_ACCESS_TOKEN}`
      }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.[0]?.display_name || null;
  } catch {
    return null;
  }
}

const STREAM_ELEMENTS_API = "https://api.streamelements.com/kappa/v2/points";
const STREAM_ELEMENTS_JWT = process.env.STREAMELEMENTS_JWT;
const STREAM_ELEMENTS_CHANNEL_ID = process.env.STREAMELEMENTS_CHANNEL_ID;

async function getUserPoints(username) {
  try {
    const res = await fetch(
      `${STREAM_ELEMENTS_API}/${STREAM_ELEMENTS_CHANNEL_ID}/${encodeURIComponent(username)}`,
      { headers: { Authorization: `Bearer ${STREAM_ELEMENTS_JWT}` } }
    );
    if (!res.ok) return 0;
    const data = await res.json();
    return data?.points || 0;
  } catch {
    return 0;
  }
}

async function deductUserPoints(username, amount) {
  try {
    await fetch(
      `${STREAM_ELEMENTS_API}/${STREAM_ELEMENTS_CHANNEL_ID}/${encodeURIComponent(username)}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${STREAM_ELEMENTS_JWT}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ points: -Math.abs(amount) }),
      }
    );
  } catch {}
}

// ===== New: Initial State Endpoint =====
app.get("/v1/state/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) return res.json({ success: false, message: "Missing user ID" });

    let gelly = await Gelly.findOne({ userId });
    if (!gelly) {
      gelly = new Gelly({ userId, points: 0 });
    }

    // Apply decay if available
    if (typeof gelly.applyDecay === "function") {
      gelly.applyDecay();
    }

    await gelly.save();
    res.json({ success: true, state: gelly });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ===== Interact Endpoint =====
app.post("/v1/interact", async (req, res) => {
  try {
    const { user, action } = req.body;
    if (!user) return res.json({ success: false, message: "Missing user ID" });

    let gelly = await Gelly.findOne({ userId: user });
    if (!gelly) gelly = new Gelly({ userId: user, points: 0 });

    // Apply decay
    if (typeof gelly.applyDecay === "function") {
      gelly.applyDecay();
    }

    // Fetch and store display name if missing
    if (!gelly.displayName) {
      gelly.displayName = (await fetchTwitchDisplayName(user)) || "Unknown";
    }
    const username = gelly.displayName;

    // Per-action cooldown
    const now = new Date();
    if (gelly.lastActionTimes[action] && now - gelly.lastActionTimes[action] < 60000) {
      return res.json({ success: false, message: "That action is on cooldown." });
    }

    let pointsAwarded = 0;
    if (action.startsWith("color:")) {
      const color = action.split(":")[1];
      if (await getUserPoints(username) < 10000) {
        return res.json({ success: false, message: "Not enough Jellybeans for color change." });
      }
      await deductUserPoints(username, 10000);
      gelly.color = color;
      pointsAwarded = 1;
    } else {
      switch (action) {
        case "feed":
          if (await getUserPoints(username) < 1000) {
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

    // Stage evolution
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
    res.status(500).json({ success: false, message: "Server error" });
  }
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PO
