// ===== server.js =====
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const WebSocket = require("ws");
require("dotenv").config();
const Gelly = require("./Gelly.js");

mongoose
  .connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ Mongo Error:", err));

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

// ===== Helpers =====
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_APP_ACCESS_TOKEN = process.env.TWITCH_APP_ACCESS_TOKEN;

async function fetchTwitchUserData(userId) {
  try {
    const cleanId = userId.startsWith("U") ? userId.substring(1) : userId;
    const res = await fetch(`https://api.twitch.tv/helix/users?id=${cleanId}`, {
      headers: {
        "Client-ID": TWITCH_CLIENT_ID,
        "Authorization": `Bearer ${TWITCH_APP_ACCESS_TOKEN}`,
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const user = data?.data?.[0];
    return user ? { displayName: user.display_name, loginName: user.login } : null;
  } catch {
    return null;
  }
}

// ===== StreamElements API =====
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

// ===== API Routes =====
app.get("/v1/state/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    let gelly = await Gelly.findOne({ userId });
    if (!gelly) gelly = new Gelly({ userId, points: 0 });

    if (typeof gelly.applyDecay === "function") gelly.applyDecay();
    await gelly.save();

    res.json({ success: true, state: gelly });
  } catch {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.get("/v1/points/:username", async (req, res) => {
  try {
    const points = await getUserPoints(req.params.username);
    res.json({ success: true, points });
  } catch {
    res.status(500).json({ success: false, points: 0 });
  }
});

app.post("/v1/interact", async (req, res) => {
  try {
    const { user, action } = req.body;
    if (!user) return res.json({ success: false, message: "Missing user ID" });

    let gelly = await Gelly.findOne({ userId: user });
    if (!gelly) gelly = new Gelly({ userId: user, points: 0 });

    if (typeof gelly.applyDecay === "function") gelly.applyDecay();

    // Ensure Twitch loginName is set
    if (!gelly.displayName || !gelly.loginName) {
      const twitchData = await fetchTwitchUserData(user);
      if (twitchData) {
        gelly.displayName = twitchData.displayName;
        gelly.loginName = twitchData.loginName;
      } else {
        gelly.displayName = "Unknown";
        gelly.loginName = "unknown";
      }
    }

    const usernameForPoints = gelly.loginName;
    let actionSucceeded = false;

    switch (action) {
      case "feed":
        if (await getUserPoints(usernameForPoints) < 1000) {
          return res.json({ success: false, message: "Not enough Jellybeans to feed." });
        }
        await deductUserPoints(usernameForPoints, 1000);
        gelly.energy = Math.min(500, gelly.energy + 20);
        actionSucceeded = true;
        break;
      case "play":
        gelly.mood = Math.min(500, gelly.mood + 20);
        actionSucceeded = true;
        break;
      case "clean":
        gelly.cleanliness = Math.min(500, gelly.cleanliness + 20);
        actionSucceeded = true;
        break;
      default:
        return res.json({ success: false, message: "Unknown action" });
    }

    if (actionSucceeded) {
      gelly.lastUpdated = new Date();
      await gelly.save();

      const updatedBalance = await getUserPoints(usernameForPoints);

      broadcastState(user, gelly);
      sendLeaderboard();

      return res.json({ success: true, newBalance: updatedBalance });
    }

    res.json({ success: false, message: "Action failed" });
  } catch {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
