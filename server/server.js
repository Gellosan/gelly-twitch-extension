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

async function sendLeaderboard() {
  let gellys = await Gelly.find();

  for (let g of gellys) {
    if (typeof g.applyDecay === "function") {
      g.applyDecay();
      await g.save();
    }

    if (!g.displayName || !g.loginName || g.loginName === "unknown") {
      const twitchData = await fetchTwitchUserData(g.userId);
      if (twitchData) {
        g.displayName = twitchData.displayName;
        g.loginName = twitchData.loginName;
        await g.save();
      }
    }
  }

  const leaderboard = gellys
    .filter(g => g.loginName !== "guest" && g.loginName !== "unknown")
    .map(g => ({
      displayName: g.displayName || g.loginName || "Unknown",
      loginName: g.loginName || "unknown",
      score: Math.floor((g.energy || 0) + (g.mood || 0) + (g.cleanliness || 0))
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

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
    if (!userId || userId.startsWith("U")) return null;
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

// ===== StreamElements API =====
const STREAM_ELEMENTS_API = "https://api.streamelements.com/kappa/v2/points";
const STREAM_ELEMENTS_JWT = process.env.STREAMELEMENTS_JWT;
const STREAM_ELEMENTS_CHANNEL_ID = process.env.STREAMELEMENTS_CHANNEL_ID;

async function getUserPoints(username) {
  try {
    if (!username || username === "guest" || username === "unknown") return 0;
    const res = await fetch(
      `${STREAM_ELEMENTS_API}/${STREAM_ELEMENTS_CHANNEL_ID}/${encodeURIComponent(username)}`,
      { headers: { Authorization: `Bearer ${STREAM_ELEMENTS_JWT}` } }
    );
    if (!res.ok) {
      console.error("[SE] getUserPoints failed:", await res.text());
      return null;
    }
    const data = await res.json();
    return typeof data?.points === "number" ? data.points : null;
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

// ===== API Routes =====
app.get("/v1/state/:userId", async (req, res) => {
  try {
    let { userId } = req.params;
    if (req.headers.authorization) {
      const realId = getRealTwitchId(req.headers.authorization);
      if (realId) userId = realId;
    }

    let gelly = await Gelly.findOne({ userId });
    if (!gelly) gelly = new Gelly({ userId, points: 0 });

    if (typeof gelly.applyDecay === "function") gelly.applyDecay();

    if (!userId || userId.startsWith("U")) {
      gelly.displayName = "Guest Viewer";
      gelly.loginName = "guest";
    } else {
      const twitchData = await fetchTwitchUserData(userId);
      if (twitchData) {
        gelly.displayName = twitchData.displayName;
        gelly.loginName = twitchData.loginName;
      }
    }

    await gelly.save();

    // Send instant update
    broadcastState(userId, gelly);

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
    let { user, action } = req.body;
    if (req.headers.authorization) {
      const realId = getRealTwitchId(req.headers.authorization);
      if (realId) user = realId;
    }
    if (!user) return res.json({ success: false, message: "Missing user ID" });

    let gelly = await Gelly.findOne({ userId: user });
    if (!gelly) gelly = new Gelly({ userId: user, points: 0 });

    if (typeof gelly.applyDecay === "function") gelly.applyDecay();

    if (!user || user.startsWith("U")) {
      gelly.displayName = "Guest Viewer";
      gelly.loginName = "guest";
    } else {
      const twitchData = await fetchTwitchUserData(user);
      if (twitchData) {
        gelly.displayName = twitchData.displayName;
        gelly.loginName = twitchData.loginName;
      }
    }

    await gelly.save();
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
      deductionAmount = 10000;
      if (userPoints < deductionAmount)
        return res.json({ success: false, message: "Not enough Jellybeans to feed." });

      const newBal = await deductUserPoints(usernameForPoints, deductionAmount);
      if (newBal === null) return res.json({ success: false, message: "Point deduction failed. Try again." });

      userPoints = newBal;
      gelly.energy = Math.min(500, gelly.energy + 20);
      actionSucceeded = true;

    // ===== COLOR CHANGE =====
    } else if (action.startsWith("color:")) {
      deductionAmount = 50000;
      if (userPoints < deductionAmount)
        return res.json({ success: false, message: "Not enough Jellybeans to change color." });

      const newBal = await deductUserPoints(usernameForPoints, deductionAmount);
      if (newBal === null) return res.json({ success: false, message: "Point deduction failed. Try again." });

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

      broadcastState(user, gelly);
      sendLeaderboard();

      // Return full updated state so panel updates instantly
      return res.json({ 
        success: true, 
        newBalance: userPoints, 
        state: gelly 
      });
    }

  } catch (err) {
    console.error("[ERROR] /v1/interact:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});
// ===== GET Inventory =====
app.get("/v1/state/:userId", async (req, res) => {
  try {
    let { userId } = req.params;
    if (req.headers.authorization) {
      const realId = getRealTwitchId(req.headers.authorization);
      if (realId) userId = realId;
    }

    let gelly = await Gelly.findOne({ userId });
    if (!gelly) gelly = new Gelly({ userId, points: 0 });

    if (typeof gelly.applyDecay === "function") gelly.applyDecay();

    if (!userId || userId.startsWith("U")) {
      gelly.displayName = "Guest Viewer";
      gelly.loginName = "guest";
    } else {
      const twitchData = await fetchTwitchUserData(userId);
      if (twitchData) {
        gelly.displayName = twitchData.displayName;
        gelly.loginName = twitchData.loginName;
      }
    }

    // Ensure inventory exists
    if (!Array.isArray(gelly.inventory)) {
      gelly.inventory = [];
    }

    await gelly.save();

    // Send instant update
    broadcastState(userId, gelly);

    res.json({
      success: true,
      state: {
        ...gelly.toObject(),
        inventory: gelly.inventory // always include inventory
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});


// ===== Buy Item =====
app.post("/v1/inventory/buy", async (req, res) => {
    try {
        const { itemId, name, type, cost, currency, transactionId } = req.body;
        let { userId } = req.body;

        if (req.headers.authorization) {
            const realId = getRealTwitchId(req.headers.authorization);
            if (realId) userId = realId;
        }

        const gelly = await Gelly.findOne({ userId });
        if (!gelly) return res.status(404).json({ success: false, message: "Player not found" });

        if (currency === "jellybeans") {
            // Existing Jellybean logic
            const usernameForPoints = gelly.loginName;
            let userPoints = await getUserPoints(usernameForPoints);
            if (userPoints < cost) return res.json({ success: false, message: "Not enough Jellybeans" });

            const newBal = await deductUserPoints(usernameForPoints, cost);
            if (newBal === null) return res.json({ success: false, message: "Point deduction failed" });

        } else if (currency === "bits") {
            // Verify Twitch Bits transaction
            const valid = await verifyBitsTransaction(transactionId, userId);
            if (!valid) return res.json({ success: false, message: "Bits payment not verified" });
        } else {
            return res.json({ success: false, message: "Invalid currency type" });
        }

        // Add to inventory
        gelly.inventory.push({ itemId, name, type, equipped: false });
        await gelly.save();

        res.json({ success: true, inventory: gelly.inventory });

    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false });
    }
});
async function verifyBitsTransaction(transactionId, userId) {
    try {
        const res = await fetch(`https://api.twitch.tv/helix/extensions/transactions?id=${transactionId}`, {
            headers: {
                "Client-ID": process.env.TWITCH_CLIENT_ID,
                "Authorization": `Bearer ${process.env.TWITCH_APP_ACCESS_TOKEN}`
            }
        });

        if (!res.ok) {
            console.error("Bits verification API failed", await res.text());
            return false;
        }

        const data = await res.json();
        const tx = data.data && data.data[0];

        return tx && tx.user_id === userId && tx.product_type === "BITS_IN_EXTENSION";
    } catch (err) {
        console.error("verifyBitsTransaction error:", err);
        return false;
    }
}
// ===== Example Store Config =====
const storeItems = [
    { id: "chain", name: "Gold chain", type: "accessory", cost: 300000, currency: "jellybeans" },
    { id: "party-hat", name: "Party Hat", type: "hat", cost: 300000, currency: "jellybeans" },
    { id: "sunglasses", name: "Sunglasses", type: "accessory", cost: 100000, currency: "jellybeans" },
    { id: "wizard-hat", name: "Wizard Hat", type: "hat", cost: 500000, currency: "jellybeans" },
    { id: "flower-crown", name: "Flower Crown", type: "hat", cost: 500000, currency: "jellybeans" },
    { id: "bat", name: "Baseball Bat", type: "weapon", cost: 500000, currency: "jellybeans" },
    { id: "gold-crown", name: "Gold Crown", type: "hat", cost: 100, currency: "bits" }, // costs bits
    { id: "sword", name: "Sword", type: "weapon", cost: 100, currency: "bits" }, // costs bits
    { id: "king-crown", name: "Royal Crown", type: "hat", cost: 100, currency: "bits" }, // costs bits
    { id: "gun", name: "M4", type: "weapon", cost: 100, currency: "bits" }, // costs bits
];

// Get Store Items
app.get("/v1/store", (req, res) => {
    res.json({ success: true, store: storeItems });
});


// ===== Equip Item =====
app.post("/v1/inventory/equip", async (req, res) => {
    try {
        const { itemId, equipped } = req.body;
        let { userId } = req.body;

        if (req.headers.authorization) {
            const realId = getRealTwitchId(req.headers.authorization);
            if (realId) userId = realId;
        }

        const gelly = await Gelly.findOne({ userId });
        if (!gelly) return res.status(404).json({ success: false });

        // Only one item of same type can be equipped
        const item = gelly.inventory.find(i => i.itemId === itemId);
        if (!item) return res.status(404).json({ success: false, message: "Item not found" });

        if (equipped) {
            // Unequip all items of same type first
            gelly.inventory.forEach(i => {
                if (i.type === item.type) i.equipped = false;
            });
        }
        item.equipped = equipped;

        await gelly.save();
        res.json({ success: true, inventory: gelly.inventory });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false });
    }
});

// ===== Admin Reset Leaderboard =====
app.post("/v1/admin/reset-leaderboard", async (req, res) => {
  try {
    await Gelly.updateMany({}, { $set: { energy: 0, mood: 0, cleanliness: 0 } });
    await sendLeaderboard();
    res.json({ success: true, message: "Leaderboard reset." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

// Simple ping endpoint to keep server awake
app.get("/ping", (req, res) => {
    res.json({ success: true, message: "Server is awake" });
});
