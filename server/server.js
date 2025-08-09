# path: server.js
// ===== Gelly Server =====
const express = require("express");
const mongoose = require("mongoose");
const WebSocket = require("ws");
require("dotenv").config();
const Gelly = require("./Gelly.js");
const jwt = require("jsonwebtoken");
const tmi = require("tmi.js");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

// ----- App -----
const app = express();
app.use(express.json());

// ===== CORS (defensive, parser-free) =====
function isAllowedOrigin(origin) {
  if (!origin) return true;
  const host = origin.replace(/^https?:\/\//i, "").split("/")[0].toLowerCase();
  if (
    /\.ext-twitch\.tv$/.test(host) ||
    /\.twitch\.tv$/.test(host) ||
    host === "localhost" ||
    host.startsWith("localhost:") ||
    host === "127.0.0.1" ||
    host.startsWith("127.0.0.1:")
  ) return true;
  return false;
}
app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  if (isAllowedOrigin(origin)) {
    res.setHeader("Vary", "Origin");
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Requested-With");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ===== Request logger =====
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.path}`);
  next();
});

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
  const gellys = await Gelly.find();
  for (const g of gellys) {
    if (typeof g.applyDecay === "function") {
      g.applyDecay();
      await g.save();
    }
  }
  const leaderboard = gellys
    .filter(g => g.loginName !== "guest" && g.loginName !== "unknown")
    .map(g => ({
      displayName: g.displayName || g.loginName || "Unknown",
      loginName: g.loginName || "unknown",
      score: Math.floor((g.energy || 0) + (g.mood || 0) + (g.cleanliness || 0)),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  const data = JSON.stringify({ type: "leaderboard", entries: leaderboard });
  for (const [, ws] of clients) if (ws.readyState === WebSocket.OPEN) ws.send(data);
}

// ===== Helpers =====
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_APP_ACCESS_TOKEN = process.env.TWITCH_APP_ACCESS_TOKEN;
const STREAM_ELEMENTS_API = "https://api.streamelements.com/kappa/v2/points";
const STREAM_ELEMENTS_JWT = process.env.STREAMELEMENTS_JWT;
const STREAM_ELEMENTS_CHANNEL_ID = process.env.STREAMELEMENTS_CHANNEL_ID;
const ALLOW_GUEST_PURCHASES = process.env.ALLOW_GUEST_PURCHASES === "true";

async function fetchTwitchUserData(userId) {
  try {
    const cleanId = userId?.startsWith("U") ? userId.substring(1) : userId;
    const res = await fetch(`https://api.twitch.tv/helix/users?id=${cleanId}`, {
      headers: { "Client-ID": TWITCH_CLIENT_ID, "Authorization": `Bearer ${TWITCH_APP_ACCESS_TOKEN}` },
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
  } catch {
    return null;
  }
}
async function fetchWithTimeout(makeReq, ms = 2500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await makeReq(ctrl.signal);
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}
async function getUserPoints(username) {
  try {
    if (!username || username === "guest" || username === "unknown") return 0;
    const url = `${STREAM_ELEMENTS_API}/${STREAM_ELEMENTS_CHANNEL_ID}/${encodeURIComponent(username)}`;
    const res = await fetchWithTimeout(
      (signal) => fetch(url, { headers: { Authorization: `Bearer ${STREAM_ELEMENTS_JWT}` }, signal }), 2500
    );
    if (!res.ok) return 0;
    const data = await res.json();
    return typeof data?.points === "number" ? data.points : 0;
  } catch {
    return 0;
  }
}
async function deductUserPoints(username, amount) {
  try {
    const current = await getUserPoints(username);
    const newTotal = Math.max(0, current - Math.abs(amount));
    const cmd = `!setpoints ${username} ${newTotal}`;
    console.log("[IRC] →", cmd);
    twitchClient.say(process.env.TWITCH_CHANNEL_NAME, cmd);
    await new Promise(r => setTimeout(r, 1500));
    return newTotal;
  } catch {
    return null;
  }
}

// ===== Store Config =====
const storeItems = [
  { id: "chain",        name: "Gold chain",   type: "accessory", cost: 300000, currency: "jellybeans" },
  { id: "party-hat",    name: "Party Hat",    type: "hat",       cost: 300000, currency: "jellybeans" },
  { id: "sunglasses",   name: "Sunglasses",   type: "accessory", cost: 100000, currency: "jellybeans" },
  { id: "wizard-hat",   name: "Wizard Hat",   type: "hat",       cost: 500000, currency: "jellybeans" },
  { id: "flower-crown", name: "Flower Crown", type: "hat",       cost: 500000, currency: "jellybeans" },
  { id: "bat",          name: "Baseball Bat", type: "weapon",    cost: 500000, currency: "jellybeans" },
  { id: "gold-crown",   name: "Gold Crown",   type: "hat",       cost: 100,    currency: "bits" },
  { id: "sword",        name: "Sword",        type: "weapon",    cost: 100,    currency: "bits" },
  { id: "king-crown",   name: "Royal Crown",  type: "hat",       cost: 100,    currency: "bits" },
  { id: "gun",          name: "M4",           type: "weapon",    cost: 100,    currency: "bits" },
];

// ===== Normalizers & cooldown helpers =====
function normalizeInventory(gelly) {
  if (!Array.isArray(gelly.inventory)) gelly.inventory = [];
}
function ensureCooldownContainer(gelly) {
  if (!gelly.lastActionTimes || typeof gelly.lastActionTimes !== "object") {
    if (gelly.lastActionTimes instanceof Map) gelly.lastActionTimes = Object.fromEntries(gelly.lastActionTimes);
    else gelly.lastActionTimes = {};
  }
}
function getCooldown(gelly, key) {
  const lat = gelly.lastActionTimes;
  if (!lat) return null;
  if (lat instanceof Map) return lat.get(key) || null;
  const v = lat[key];
  return v ? new Date(v) : null;
}
function setCooldown(gelly, key, when) {
  if (gelly.lastActionTimes instanceof Map) gelly.lastActionTimes.set(key, when);
  else gelly.lastActionTimes[key] = when;
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

    ensureCooldownContainer(gelly);
    normalizeInventory(gelly);

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
    broadcastState(userId, gelly);
    return res.json({ success: true, state: gelly });
  } catch (err) {
    console.error("[ERROR] GET /v1/state:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

app.get("/v1/points/:username", async (req, res) => {
  try {
    const points = await getUserPoints(req.params.username);
    return res.json({ success: true, points });
  } catch (err) {
    console.error("[ERROR] GET /v1/points:", err);
    return res.status(500).json({ success: false, points: 0 });
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

    ensureCooldownContainer(gelly);
    normalizeInventory(gelly);

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

    const ACTION_COOLDOWNS = { feed: 300000, clean: 240000, play: 180000, color: 60000 };
    const cooldownKey = action.startsWith("color:") ? "color" : action;
    const cooldown = ACTION_COOLDOWNS[cooldownKey] || 60000;
    const now = new Date();

    const last = getCooldown(gelly, cooldownKey);
    if (last && now - last < cooldown) {
      const remaining = Math.ceil((cooldown - (now - last)) / 1000);
      return res.json({ success: false, message: `Please wait ${remaining}s before ${cooldownKey} again.` });
    }

    setCooldown(gelly, cooldownKey, now);

    let actionSucceeded = false;

    if (action === "feed") {
      const cost = 10000;
      if (userPoints < cost) return res.json({ success: false, message: "Not enough Jellybeans to feed." });
      const newBal = await deductUserPoints(usernameForPoints, cost);
      if (newBal === null) return res.json({ success: false, message: "Point deduction failed. Try again." });
      userPoints = newBal;

      const result = gelly.updateStats("feed");
      if (!result.success) return res.json({ success: false, message: result.message });
      actionSucceeded = true;

    } else if (action.startsWith("color:")) {
      const cost = 50000;
      if (userPoints < cost) return res.json({ success: false, message: "Not enough Jellybeans to change color." });
      const newBal = await deductUserPoints(usernameForPoints, cost);
      if (newBal === null) return res.json({ success: false, message: "Point deduction failed. Try again." });
      userPoints = newBal;

      gelly.color = action.split(":")[1] || "blue";
      actionSucceeded = true;

    } else if (action === "play") {
      const result = gelly.updateStats("play");
      if (!result.success) return res.json({ success: false, message: result.message });
      actionSucceeded = true;

    } else if (action === "clean") {
      const result = gelly.updateStats("clean");
      if (!result.success) return res.json({ success: false, message: result.message });
      actionSucceeded = true;

    } else if (action === "startgame") {
      gelly.points = 0;
      gelly.energy = 100;
      gelly.mood = 100;
      gelly.cleanliness = 100;
      gelly.stage = "egg";
      gelly.lastUpdated = new Date();
      actionSucceeded = true;

    } else {
      return res.json({ success: false, message: "Unknown action" });
    }

    if (actionSucceeded) {
      await gelly.save();
      broadcastState(user, gelly);
      sendLeaderboard();
      return res.json({ success: true, newBalance: userPoints, state: gelly });
    }
  } catch (err) {
    console.error("[ERROR] POST /v1/interact:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ===== Get Inventory =====
app.get("/v1/inventory/:userId", async (req, res) => {
  try {
    let { userId } = req.params;
    if (req.headers.authorization) {
      const realId = getRealTwitchId(req.headers.authorization);
      if (realId) userId = realId;
    }

    let gelly = await Gelly.findOne({ userId });
    if (!gelly) gelly = new Gelly({ userId, points: 0, inventory: [] });

    ensureCooldownContainer(gelly);
    normalizeInventory(gelly);

    if (typeof gelly.applyDecay === "function") gelly.applyDecay();

    await gelly.save();
    broadcastState(userId, gelly);

    return res.json({ success: true, inventory: gelly.inventory });
  } catch (err) {
    console.error("[ERROR] GET /v1/inventory:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ===== Buy Item =====
app.post("/v1/inventory/buy", async (req, res) => {
  try {
    let { userId, itemId, name, type, cost, currency, transactionId } = req.body;

    if (req.headers.authorization) {
      const realId = getRealTwitchId(req.headers.authorization);
      if (realId) userId = realId;
    }

    let gelly = await Gelly.findOne({ userId });
    if (!gelly) gelly = new Gelly({ userId, points: 0, inventory: [] });

    if (!gelly.loginName) {
      const twitchData = await fetchTwitchUserData(userId);
      if (twitchData) {
        gelly.displayName = twitchData.displayName;
        gelly.loginName = twitchData.loginName;
      } else {
        gelly.displayName = gelly.displayName || "Guest Viewer";
        gelly.loginName = gelly.loginName || "guest";
      }
    }

    ensureCooldownContainer(gelly);
    normalizeInventory(gelly);

    const storeItem = storeItems.find(s => s.id === itemId);
    if (!storeItem) return res.json({ success: false, message: "Invalid store item" });

    name = storeItem.name;
    type = storeItem.type;
    cost = storeItem.cost;
    currency = storeItem.currency;

    if (currency === "jellybeans") {
      const isGuest = !gelly.loginName || gelly.loginName === "guest" || gelly.loginName === "unknown";
      if (isGuest && ALLOW_GUEST_PURCHASES) {
        console.log("[BUY] Guest purchase allowed by ALLOW_GUEST_PURCHASES");
      } else {
        const usernameForPoints = gelly.loginName || "guest";
        const userPoints = await getUserPoints(usernameForPoints);
        if (userPoints < cost) return res.json({ success: false, message: "Not enough Jellybeans" });
        const newBal = await deductUserPoints(usernameForPoints, cost);
        if (newBal === null) return res.json({ success: false, message: "Point deduction failed" });
      }
    } else if (currency === "bits") {
      const valid = await verifyBitsTransaction(transactionId, userId);
      if (!valid) return res.json({ success: false, message: "Bits payment not verified" });
    } else {
      return res.json({ success: false, message: "Invalid currency type" });
    }

    if (!gelly.inventory.some(i => i.itemId === itemId)) {
      gelly.inventory.push({ itemId, name, type, equipped: false });
      console.log("[BUY] Added:", { userId, itemId });
    }

    await gelly.save();
    broadcastState(userId, gelly);
    sendLeaderboard();

    return res.json({ success: true, inventory: gelly.inventory });
  } catch (err) {
    console.error("[ERROR] POST /v1/inventory/buy:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ===== Equip Item =====
app.post(/^\/v1\/inventory\/equip\/?$/, async (req, res) => {
  try {
    let { userId, itemId, equipped } = req.body;

    if (req.headers.authorization) {
      const realId = getRealTwitchId(req.headers.authorization);
      if (realId) userId = realId;
    }

    const gelly = await Gelly.findOne({ userId });
    if (!gelly) return res.status(404).json({ success: false, message: "User not found" });

    ensureCooldownContainer(gelly);
    normalizeInventory(gelly);

    const item = gelly.inventory.find(i => (i.itemId || "").toLowerCase() === (itemId || "").toLowerCase());
    if (!item) return res.status(404).json({ success: false, message: "Item not found" });

    if (equipped) {
      gelly.inventory.forEach(i => {
        if (i.type === item.type && i.itemId !== item.itemId) i.equipped = false;
      });
    }

    item.equipped = !!equipped;

    await gelly.save();
    broadcastState(userId, gelly);

    return res.json({ success: true, inventory: gelly.inventory });
  } catch (err) {
    console.error("[ERROR] POST /v1/inventory/equip:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// Probe for debugging
app.get(/^\/v1\/inventory\/equip\/?$/, (_req, res) => {
  res.json({ success: true, message: "equip endpoint alive; use POST" });
});

app.get("/v1/store", (_req, res) => res.json({ success: true, store: storeItems }));

// ===== Admin Reset Leaderboard =====
app.post("/v1/admin/reset-leaderboard", async (_req, res) => {
  try {
    await Gelly.updateMany({}, { $set: { energy: 0, mood: 0, cleanliness: 0 } });
    await sendLeaderboard();
    return res.json({ success: true, message: "Leaderboard reset." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false });
  }
});

// Optional: quick grant endpoint for testing
app.post("/v1/admin/grant", async (req, res) => {
  try {
    const { userId: rawUser, itemId } = req.body || {};
    if (!rawUser || !itemId) return res.status(400).json({ success: false, message: "userId and itemId required" });
    const item = storeItems.find(s => s.id === itemId);
    if (!item) return res.json({ success: false, message: "Invalid store item" });

    let userId = rawUser;
    if (req.headers.authorization) {
      const realId = getRealTwitchId(req.headers.authorization);
      if (realId) userId = realId;
    }

    let gelly = await Gelly.findOne({ userId });
    if (!gelly) gelly = new Gelly({ userId, points: 0, inventory: [] });
    normalizeInventory(gelly);

    if (!gelly.inventory.some(i => i.itemId === itemId)) {
      gelly.inventory.push({ itemId, name: item.name, type: item.type, equipped: false });
    }

    await gelly.save();
    broadcastState(userId, gelly);
    return res.json({ success: true, inventory: gelly.inventory });
  } catch (e) {
    console.error("[ERROR] /v1/admin/grant:", e);
    return res.status(500).json({ success: false });
  }
});

// Helpful 404
app.use((req, res) => {
  console.warn(`[404] ${req.method} ${req.originalUrl}`);
  res.status(404).json({ success: false, message: "Not Found", method: req.method, path: req.originalUrl });
});

// ===== Bits verification =====
async function verifyBitsTransaction(transactionId, userId) {
  try {
    const res = await fetch(`https://api.twitch.tv/helix/extensions/transactions?id=${transactionId}`, {
      headers: { "Client-ID": process.env.TWITCH_CLIENT_ID, "Authorization": `Bearer ${process.env.TWITCH_APP_ACCESS_TOKEN}` }
    });
    if (!res.ok) return false;
    const data = await res.json();
    const tx = data.data && data.data[0];
    return !!(tx && tx.user_id === userId && tx.product_type === "BITS_IN_EXTENSION");
  } catch {
    return false;
  }
}

// ===== Start server =====
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
