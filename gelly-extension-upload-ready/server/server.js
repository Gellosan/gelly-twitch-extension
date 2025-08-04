const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const WebSocket = require("ws");
require("dotenv").config();
const Gelly = require("./Gelly.js");
const app = express();
const tmi = require("tmi.js");
const jwt = require("jsonwebtoken");

const twitchClient = new tmi.Client({
  identity: {
    username: process.env.TWITCH_BOT_USERNAME,
    password: process.env.TWITCH_OAUTH_TOKEN
  },
  channels: [process.env.TWITCH_CHANNEL_NAME]
});

twitchClient.connect().then(() =>
  console.log("✅ Connected to Twitch chat as", process.env.TWITCH_BOT_USERNAME)
).catch(console.error);

mongoose
  .connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ Mongo Error:", err));

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

    if (!res.ok) {
      console.error("[SE] getUserPoints failed:", await res.text());
      return null;
    }

    const data = await res.json();
    if (typeof data?.points !== "number") {
      console.error("[SE] Unexpected getUserPoints response:", data);
      return null;
    }

    return data.points;
  } catch (err) {
    console.error("[SE] getUserPoints error:", err);
    return null;
  }
}

async function deductUserPoints(username, amount) {
  try {
    const current = await getUserPoints(username);
    if (current === null) return null;

    const newTotal = Math.max(0, current - Math.abs(amount));
    const cmd = `!setpoints ${username} ${newTotal}`;
    console.log("[IRC] →", cmd);
    twitchClient.say(process.env.TWITCH_CHANNEL_NAME, cmd);

    await new Promise(r => setTimeout(r, 1500));
    return newTotal;
  } catch (err) {
    console.error("[deductUserPoints] error:", err);
    return null;
  }
}

// ===== Leaderboard =====
async function sendLeaderboard() {
  let gellys = await Gelly.find();

  for (let g of gellys) {
    if (typeof g.applyDecay === "function") {
      g.applyDecay();
      await g.save();
    }

    // ✅ Fix unknowns by fetching Twitch names
    if (!g.displayName || !g.loginName || g.loginName === "unknown") {
      const twitchData = await fetchTwitchUserData(g.userId);
      if (twitchData) {
        g.displayName = twitchData.displayName;
        g.loginName = twitchData.loginName;
        await g.save();
      }
    }
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

// ===== API Routes =====
app.get("/v1/state/:userId", async (req, res) => {
  try {
    // Try JWT first
    const twitchId = getRealTwitchId(req.headers.authorization) || req.params.userId;

    let gelly = await Gelly.findOne({ userId: twitchId });
    if (!gelly) gelly = new Gelly({ userId: twitchId, points: 0 });

    // Always fetch Twitch name if missing or unknown
    if (!gelly.displayName || !gelly.loginName || gelly.loginName === "unknown") {
      const twitchData = await fetchTwitchUserData(twitchId);
      if (twitchData) {
        gelly.displayName = twitchData.displayName;
        gelly.loginName = twitchData.loginName;
      } else {
        gelly.displayName = "Unknown";
        gelly.loginName = "unknown";
      }
      await gelly.save();
    }

    if (typeof gelly.applyDecay === "function") {
      gelly.applyDecay();
    }
    await gelly.save();

    res.json({ success: true, state: gelly });
  } catch (err) {
    console.error("[ERROR] /v1/state:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.post("/v1/interact", async (req, res) => {
  try {
    let { user, action } = req.body;

    // Try JWT first
    const twitchId = getRealTwitchId(req.headers.authorization) || user;
    if (!twitchId) return res.json({ success: false, message: "Missing user ID" });

    let gelly = await Gelly.findOne({ userId: twitchId });
    if (!gelly) gelly = new Gelly({ userId: twitchId, points: 0 });

    if (typeof gelly.applyDecay === "function") gelly.applyDecay();

    // Always resolve Twitch name first
    if (!gelly.displayName || !gelly.loginName || gelly.loginName === "unknown") {
      const twitchData = await fetchTwitchUserData(twitchId);
      if (twitchData) {
        gelly.displayName = twitchData.displayName;
        gelly.loginName = twitchData.loginName;
      } else {
        gelly.displayName = "Unknown";
        gelly.loginName = "unknown";
      }
      await gelly.save();
    }

    const usernameForPoints = gelly.loginName;
    let userPoints = await getUserPoints(usernameForPoints);
    console.log(`[DEBUG] Interact: ${action} for ${usernameForPoints} | Current points: ${userPoints}`);

    const ACTION_COOLDOWNS = { feed: 300000, clean: 240000, play: 180000, color: 60000 };
    const cooldownKey = action.startsWith("color:") ? "color" : action;
    const cooldown = ACTION_COOLDOWNS[cooldownKey] || 60000;
    const now = new Date();

    if (gelly.lastActionTimes[cooldownKey] && now - gelly.lastActionTimes[cooldownKey] < cooldown) {
      const remaining = Math.ceil((cooldown - (now - gelly.lastActionTimes[cooldownKey])) / 1000);
      return res.json({ success: false, message: `Please wait ${remaining}s before ${cooldownKey} again.` });
    }

    let actionSucceeded = false;
    let deductionAmount = 0;

    // ===== FEED =====
    if (action === "feed") {
      deductionAmount = 1000;
      if (userPoints < deductionAmount)
        return res.json({ success: false, message: "Not enough Jellybeans to feed." });

      const newBal = await deductUserPoints(usernameForPoints, deductionAmount);
      if (newBal === null)
        return res.json({ success: false, message: "Point deduction failed. Try again." });

      userPoints = newBal;
      gelly.energy = Math.min(500, gelly.energy + 20);
      actionSucceeded = true;

    // ===== COLOR CHANGE =====
    } else if (action.startsWith("color:")) {
      deductionAmount = 10000;
      if (userPoints < deductionAmount)
        return res.json({ success: false, message: "Not enough Jellybeans to change color." });

      const newBal = await deductUserPoints(usernameForPoints, deductionAmount);
      if (newBal === null)
        return res.json({ success: false, message: "Point deduction failed. Try again." });

      userPoints = newBal;
      gelly.color = action.split(":")[1] || "blue";
      actionSucceeded = true;

    // ===== PLAY =====
    } else if (action === "play") {
      gelly.mood = Math.min(500, gelly.mood + 20);
      actionSucceeded = true;

    // ===== CLEAN =====
    } else if (action === "clean") {
      gelly.cleanliness = Math.min(500, gelly.cleanliness + 20);
      actionSucceeded = true;

    // ===== START GAME =====
    } else if (action === "startgame") {
      gelly.points = 0;
      gelly.energy = 100;
      gelly.mood = 100;
      gelly.cleanliness = 100;
      gelly.lastUpdated = new Date();
      actionSucceeded = true;
    } else {
      return res.json({ success: false, message: "Unknown action" });
    }

    if (actionSucceeded) {
      gelly.lastActionTimes[cooldownKey] = now;
      await gelly.save();
      broadcastState(twitchId, gelly);
      sendLeaderboard();
      return res.json({ success: true, newBalance: userPoints });
    }

    res.json({ success: false, message: "Action failed" });
  } catch (err) {
    console.error("[ERROR] /v1/interact:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});


const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
