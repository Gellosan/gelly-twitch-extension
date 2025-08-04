// ===== Gelly Server =====
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const WebSocket = require("ws");
require("dotenv").config();
const Gelly = require("./Gelly.js");
const jwt = require("jsonwebtoken");
const tmi = require("tmi.js");

const app = express();

// ===== Twitch Bot Setup =====
const twitchClient = new tmi.Client({
  identity: {
    username: process.env.TWITCH_BOT_USERNAME,
    password: process.env.TWITCH_OAUTH_TOKEN
  },
  channels: [process.env.TWITCH_CHANNEL_NAME]
});

twitchClient.connect()
  .then(() => console.log("✅ Connected to Twitch chat as", process.env.TWITCH_BOT_USERNAME))
  .catch(console.error);

// ===== MongoDB =====
mongoose
  .connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ Mongo Error:", err));

// ===== Middleware =====
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

// ===== WebSocket =====
const server = require("http").createServer(app);
const wss = new WebSocket.Server({ server });
const clients = new Map();

wss.on("connection", (ws, req) => {
  const searchParams = new URL(req.url, `http://${req.headers.host}`).searchParams;
  let userId = normalizeTwitchId(searchParams.get("user"));

  if (userId) {
    clients.set(userId, ws);
    console.log(`🔌 WebSocket connected for user: ${userId}`);
    sendLeaderboard().catch(console.error);
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

// ===== Leaderboard =====
async function sendLeaderboard() {
  let gellys = await Gelly.find();

  for (let g of gellys) {
    if (typeof g.applyDecay === "function") {
      g.applyDecay();
    }

    if (!g.displayName || !g.loginName || g.loginName === "unknown") {
      const twitchData = await fetchTwitchUserData(g.userId);
      if (twitchData) {
        g.displayName = twitchData.displayName;
        g.loginName = twitchData.loginName;
      }
    }
    await g.save();
  }

  const leaderboard = gellys.map(g => ({
    displayName: g.displayName || g.loginName || "Unknown",
    loginName: g.loginName || "unknown",
    score: Math.floor((g.energy || 0) + (g.mood || 0) + (g.cleanliness || 0))
  }));

  leaderboard.sort((a, b) => b.score - a.score);
  const top10 = leaderboard.slice(0, 10);

  const data = JSON.stringify({ type: "leaderboard", entries: top10 });
  for (const [, ws] of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

// ===== Helpers =====
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_APP_ACCESS_TOKEN = process.env.TWITCH_APP_ACCESS_TOKEN;

function normalizeTwitchId(id) {
  if (!id) return null;
  return id.startsWith("U") ? id.substring(1) : id;
}

async function fetchTwitchUserData(userId) {
  try {
    const res = await fetch(`https://api.twitch.tv/helix/users?id=${userId}`, {
      headers: {
        "Client-ID": TWITCH_CLIENT_ID,
        "Authorization": `Bearer ${TWITCH_APP_ACCESS_TOKEN}`
      }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const user = data?.data?.[0];
    return user ? { displayName: user.display_name, loginName: user.login } : null;
  } catch {
    return null;
  }
}

function getRealTwitchId(authHeader) {
  if (!authHeader) return null;
  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.decode(token);
    return decoded?.user_id || null;
  } catch (err) {
    console.error("JWT decode error:", err);
    return null;
  }
}

// ===== StreamElements =====
const STREAM_ELEMENTS_API = "https://api.streamelements.com/kappa/v2/points";
const STREAM_ELEMENTS_JWT = process.env.STREAMELEMENTS_JWT;
const STREAM_ELEMENTS_CHANNEL_ID = process.env.STREAMELEMENTS_CHANNEL_ID;

async function getUserPoints(username) {
  try {
    const res = await fetch(
      `${STREAM_ELEMENTS_API}/${STREAM_ELEMENTS_CHANNEL_ID}/${encodeURIComponent(username)}`,
      { headers: { Authorization: `Bearer ${STREAM_ELEMENTS_JWT}` } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.points === "number" ? data.points : null;
  } catch {
    return null;
  }
}

// ===== API Routes =====
app.get("/v1/state/:userId", async (req, res) => {
  try {
    const userId = normalizeTwitchId(req.params.userId);

    let gelly = await Gelly.findOne({ userId });
    if (!gelly) {
      gelly = new Gelly({ userId, points: 0 });
      const twitchData = await fetchTwitchUserData(userId);
      if (twitchData) {
        gelly.displayName = twitchData.displayName;
        gelly.loginName = twitchData.loginName;
      }
    }

    if (typeof gelly.applyDecay === "function") {
      gelly.applyDecay();
    }

    await gelly.save();
    res.json({ success: true, state: gelly });
  } catch {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.post("/v1/interact", async (req, res) => {
  try {
    let { user, action } = req.body;
    if (req.headers.authorization) {
      const realId = normalizeTwitchId(getRealTwitchId(req.headers.authorization));
      if (realId) user = realId;
    }
    user = normalizeTwitchId(user);
    if (!user) return res.json({ success: false, message: "Missing user ID" });

    let gelly = await Gelly.findOne({ userId: user });
    if (!gelly) {
      gelly = new Gelly({ userId: user, points: 0 });
      const twitchData = await fetchTwitchUserData(user);
      if (twitchData) {
        gelly.displayName = twitchData.displayName;
        gelly.loginName = twitchData.loginName;
      }
    }

    if (typeof gelly.applyDecay === "function") gelly.applyDecay();

    if (!gelly.displayName || !gelly.loginName || gelly.loginName === "unknown") {
      const twitchData = await fetchTwitchUserData(user);
      if (twitchData) {
        gelly.displayName = twitchData.displayName;
        gelly.loginName = twitchData.loginName;
      }
    }

    const usernameForPoints = gelly.loginName;
    const userPoints = await getUserPoints(usernameForPoints);

    const { success } = gelly.updateStats(action);
    if (!success) return res.json({ success: false, message: "Action failed" });

    await gelly.save();
    broadcastState(user, gelly);
    sendLeaderboard();

    res.json({ success: true, newBalance: userPoints });
  } catch (err) {
    console.error("[ERROR] /v1/interact:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ===== Server =====
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
