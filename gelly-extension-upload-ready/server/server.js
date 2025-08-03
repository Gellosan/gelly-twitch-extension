const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const WebSocket = require("ws");
require("dotenv").config();
const Gelly = require("./Gelly.js");
const app = express();

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
  let gellys = await Gelly.find();

  // Apply decay to all and save
  for (let g of gellys) {
    if (typeof g.applyDecay === "function") {
      g.applyDecay();
      await g.save();
    }
  }

  // Create care score
  const leaderboard = gellys.map(g => ({
    displayName: g.displayName || g.loginName || "Unknown",
    loginName: g.loginName || "unknown",
    score: Math.floor((g.energy || 0) + (g.mood || 0) + (g.cleanliness || 0))
  }));

  // Sort by score
  leaderboard.sort((a, b) => b.score - a.score);

  // Top 10 only
  const top10 = leaderboard.slice(0, 10);

  // Send leaderboard to all clients
  const data = JSON.stringify({ type: "leaderboard", entries: top10 });
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
    const res = await fetch(
      `https://api.streamelements.com/kappa/v2/points/${67c5724091fe00099031263f}/${encodeURIComponent(username)}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJjaXRhZGVsIiwiZXhwIjoxNzU2NTQ1MDg4LCJqdGkiOiI4ZGMzNDMxZS0xZWI4LTQ3ODQtYTU1Ny0zODBhMWYyNjJlM2YiLCJjaGFubmVsIjoiNjdjNTcyNDA5MWZlMDAwOTkwMzEyNjNmIiwicm9sZSI6Im93bmVyIiwiYXV0aFRva2VuIjoiSkNVNVBZakRETzB6WFlmZ1l5T3EyTG04M3FUbjkya3B0SnJkWVg3dTZvUlRxUHhDIiwidXNlciI6IjY3YzU3MjQwOTFmZTAwMDk5MDMxMjYzZSIsInVzZXJfaWQiOiJlM2RjYjFkMy00NDNiLTQ1ODgtODQ4Ny0xMmRiYjMxZGRjOGUiLCJ1c2VyX3JvbGUiOiJjcmVhdG9yIiwicHJvdmlkZXIiOiJ0d2l0Y2giLCJwcm92aWRlcl9pZCI6IjUzMjQ0NzI1NyIsImNoYW5uZWxfaWQiOiI5YTljZGIzYy1hNDlmLTQ1OGUtODA2Zi03YjE5NGFhZTgzNzEiLCJjcmVhdG9yX2lkIjoiNTkyNTdlZjgtZDNiOS00YzNiLWFhMDMtMzMzOWU1ZDk0YTIwIn0.tYrIHGEhYfT1fxVPQayV7uRUqh52sYzJzPhhcTwB-lA}`, // from your .env
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          points: -Math.abs(amount) // negative number to subtract
        }),
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      console.error("[ERROR] Failed to deduct points via SE API:", errText);
    } else {
      console.log(`[DEBUG] Deducted ${amount} Jellybeans from ${username} via SE API`);
    }
  } catch (err) {
    console.error("[ERROR] deductUserPoints via SE API:", err);
  }
}


    if (!res.ok) {
      const errText = await res.text();
      console.error("[ERROR] SE bot send failed:", errText);
    } else {
      console.log(`[DEBUG] Sent to SE bot: !addpoints ${username} -${Math.abs(amount)}`);
    }
  } catch (err) {
    console.error("[ERROR] deductUserPoints via SE bot:", err);
  }
}



// ===== API Routes =====
app.get("/v1/state/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    let gelly = await Gelly.findOne({ userId });
    if (!gelly) gelly = new Gelly({ userId, points: 0 });

    if (typeof gelly.applyDecay === "function") {
      gelly.applyDecay();
      await gelly.save();
    }

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
// Cache recent balances so we don't re-fetch from SE too soon
const lastKnownPoints = {};

app.post("/v1/interact", async (req, res) => {
  try {
    const { user, action } = req.body;
    if (!user) return res.json({ success: false, message: "Missing user ID" });

    let gelly = await Gelly.findOne({ userId: user });
    if (!gelly) gelly = new Gelly({ userId: user, points: 0 });

    if (typeof gelly.applyDecay === "function") gelly.applyDecay();

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
    console.log(`[DEBUG] Interact: ${action} for ${usernameForPoints}`);
    let userPoints;

    // Use cached value if available and recent (5 seconds old or less)
    if (lastKnownPoints[usernameForPoints] && (Date.now() - lastKnownPoints[usernameForPoints].time < 5000)) {
      userPoints = lastKnownPoints[usernameForPoints].points;
      console.log(`[DEBUG] Using cached points: ${userPoints}`);
    } else {
      userPoints = await getUserPoints(usernameForPoints);
      console.log(`[DEBUG] SE returned points: ${userPoints}`);
    }

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
      if (userPoints < deductionAmount) {
        return res.json({ success: false, message: "Not enough Jellybeans to feed." });
      }
      await deductUserPoints(usernameForPoints, deductionAmount);
      gelly.energy = Math.min(500, gelly.energy + 20);
      actionSucceeded = true;

    // ===== COLOR CHANGE =====
    } else if (action.startsWith("color:")) {
      deductionAmount = 10000;
      if (userPoints < deductionAmount) {
        return res.json({ success: false, message: "Not enough Jellybeans to change color." });
      }
      await deductUserPoints(usernameForPoints, deductionAmount);
      gelly.color = action.split(":")[1] || "blue"; // always save color
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

      // ✅ Instantly update balance without waiting for SE delay
      const updatedBalance = Math.max(0, userPoints - deductionAmount);
      lastKnownPoints[usernameForPoints] = { points: updatedBalance, time: Date.now() };

      // Send updates to panel + leaderboard
      broadcastState(user, gelly);
      sendLeaderboard();

      return res.json({ success: true, newBalance: updatedBalance });
    }

    res.json({ success: false, message: "Action failed" });

  } catch (err) {
    console.error("[ERROR] /v1/interact:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});



const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
