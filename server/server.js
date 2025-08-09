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


# path: panel.js
// ===== Gelly Extension Panel Script =====
let twitchUserId = null;
let twitchAuthToken = null;
let loginName = null;
let jellybeanBalance = 0;
let currentStage = "egg";
let currentColor = "blue";

// ===== UI Elements =====
const jellybeanBalanceEl = document.getElementById("jellybeanBalance");
const energyEl = document.getElementById("energy");
const moodEl = document.getElementById("mood");
const cleanlinessEl = document.getElementById("cleanliness");
const leaderboardList = document.getElementById("leaderboard-list");
const messageEl = document.getElementById("message");
const COLOR_CHANGE_COST = 50000;

// ===== Link Account Button =====
function showLinkButton() {
  const linkBtn = document.getElementById("linkAccountBtn");
  if (!linkBtn) return;
  linkBtn.style.display = "block";
  linkBtn.addEventListener("click", () => {
    Twitch.ext.actions.requestIdShare();
    localStorage.setItem("linkedOnce", "true");
    linkBtn.style.display = "none";
    setTimeout(() => initGame(), 1000);
  });
}

// ===== Utility =====
function showTempMessage(msg) {
  messageEl.textContent = msg;
  setTimeout(() => (messageEl.textContent = ""), 3000);
}
const getGellyImg = () => document.getElementById("gelly-image");

function playAnim(cls) {
  const img = getGellyImg();
  if (!img) return;
  img.classList.remove("gelly-feed-anim", "gelly-play-anim", "gelly-clean-anim", "bounce");
  void img.offsetWidth;
  img.classList.add(cls);
  setTimeout(() => img.classList.remove(cls), 800);
}
function triggerGellyAnimation(action) {
  if (action === "feed") playAnim("gelly-feed-anim");
  else if (action === "play") playAnim("gelly-play-anim");
  else if (action === "clean") playAnim("gelly-clean-anim");
}
function animateGelly() {
  const img = getGellyImg();
  if (!img) return;
  img.classList.remove("bounce");
  void img.offsetWidth;
  img.classList.add("bounce");
  setTimeout(() => img.classList.remove("bounce"), 800);
}
function triggerColorChangeEffect() {
  const gameContainer = document.getElementById("gelly-container");
  if (!gameContainer) return;
  gameContainer.classList.add("evolution-active");
  setTimeout(() => gameContainer.classList.remove("evolution-active"), 2500);
}

// ===== Gelly Image =====
function updateGellyImage(stage, color) {
  const container = document.getElementById("background");
  let img = document.getElementById("gelly-image");
  const src =
    stage === "egg" ? "assets/egg.png" :
    stage === "blob" ? `assets/blob-${color}.png` :
    `assets/gelly-${color}.png`;

  if (img) { img.src = src; return; }
  img = document.createElement("img");
  img.id = "gelly-image";
  img.src = src;
  container.appendChild(img);
}

// ===== Inventory =====
async function fetchInventory(userId) {
  try {
    const res = await fetch(`https://gelly-server.onrender.com/v1/inventory/${userId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${twitchAuthToken}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) return { inventory: [] };
    const data = await res.json();
    return data;
  } catch {
    return { inventory: [] };
  }
}

function renderInventory(items = []) {
  const invContainer = document.getElementById("inventory");
  invContainer.innerHTML = "";
  items.forEach((item) => {
    const div = document.createElement("div");
    div.className = "inventory-item";
    div.textContent = item.name + (item.equipped ? " (Equipped)" : "");
    div.addEventListener("click", () => equipItem(item.itemId, !item.equipped));
    invContainer.appendChild(div);
  });

  updateGellyImage(currentStage, currentColor);
  renderEquippedAccessories(items);
}

async function equipItem(itemId, equipped) {
  try {
    const res = await fetch(`https://gelly-server.onrender.com/v1/inventory/equip`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${twitchAuthToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userId: twitchUserId, itemId, equipped }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.warn("Equip HTTP error:", res.status, txt);
      showTempMessage("Equip failed");
      return;
    }
    const data = await res.json();
    if (data.success) {
      renderInventory(data.inventory || []);
      renderEquippedAccessories(data.inventory || []);
      animateGelly();
      // also refresh store buttons (Owned state)
      if (document.getElementById("store-menu")?.style.display === "block") {
        fetchStore();
      }
    } else {
      showTempMessage(data.message || "Equip failed");
    }
  } catch (err) {
    console.error("Equip request failed:", err);
  }
}

// ===== Store =====
async function fetchStore() {
  try {
    const res = await fetch(`https://gelly-server.onrender.com/v1/store`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.success) renderStore(data.store);
  } catch (err) {
    console.error("Failed to fetch store:", err);
  }
}

const safeBind = (id, event, handler) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener(event, handler);
};

// Inventory open/close
safeBind("openInventoryBtn", "click", () => {
  document.getElementById("gelly-container").style.display = "none";
  document.getElementById("inventory-menu").style.display = "block";
});
safeBind("backFromInventoryBtn", "click", () => {
  document.getElementById("inventory-menu").style.display = "none";
  document.getElementById("gelly-container").style.display = "block";
});

// Store open/close
safeBind("openStoreBtn", "click", () => {
  document.getElementById("gelly-container").style.display = "none";
  document.getElementById("store-menu").style.display = "block";
});
safeBind("backFromStoreBtn", "click", () => {
  document.getElementById("store-menu").style.display = "none";
  document.getElementById("gelly-container").style.display = "block";
});

async function renderStore(items = []) {
  const storeContainer = document.getElementById("store");
  storeContainer.innerHTML = "";

  const inventoryData = await fetchInventory(twitchUserId);
  const ownedItems = (inventoryData.inventory || []).map((i) => i.itemId);

  items.forEach((item) => {
    const itemDiv = document.createElement("div");
    itemDiv.className = "store-item";

    const img = document.createElement("img");
    img.src = `assets/${item.id}.png`;
    img.alt = item.name;

    const nameEl = document.createElement("p");
    nameEl.textContent = item.name;

    const costEl = document.createElement("p");
    costEl.textContent = `${item.cost} ${item.currency}`;

    const buyBtn = document.createElement("button");

    if (ownedItems.includes(item.id)) {
      buyBtn.textContent = "Owned";
      buyBtn.disabled = true;
      buyBtn.style.backgroundColor = "#aaa";
      buyBtn.style.cursor = "not-allowed";
    } else {
      buyBtn.textContent = "Buy";
      buyBtn.addEventListener("click", () => {
        if (item.currency === "jellybeans") {
          buyWithJellybeans(item);
        } else if (item.currency === "bits" && window.Twitch?.ext?.bits) {
          buyWithBits(item);
        } else {
          showTempMessage("Bits not available in this context");
        }
      });
    }

    itemDiv.appendChild(img);
    itemDiv.appendChild(nameEl);
    itemDiv.appendChild(costEl);
    itemDiv.appendChild(buyBtn);
    storeContainer.appendChild(itemDiv);
  });
}

// Buy with jellybeans
async function buyWithJellybeans(item) {
  try {
    const res = await fetch(`https://gelly-server.onrender.com/v1/inventory/buy`, {
      method: "POST",
      headers: { Authorization: `Bearer ${twitchAuthToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: twitchUserId,
        itemId: item.id,
        name: item.name,
        type: item.type,
        cost: item.cost,
        currency: "jellybeans",
      }),
    });
    const data = await res.json();
    if (data.success) {
      showTempMessage(`Purchased ${item.name}!`);
      renderInventory(data.inventory || []);
      updateGellyImage(currentStage, currentColor);
      renderEquippedAccessories(data.inventory || []);
      fetchJellybeanBalance();
      animateGelly();
      // refresh store list to mark “Owned”
      fetchStore();
    } else {
      showTempMessage(data.message || "Purchase failed");
    }
  } catch (err) {
    console.error("Buy Jellybeans failed:", err);
  }
}

// Buy with bits
async function buyWithBits(item) {
  try {
    Twitch.ext.bits
      .getProducts()
      .then((products) => {
        const product = products.find((p) => p.sku === item.id);
        if (!product) {
          showTempMessage("Bits product not found");
          return;
        }
        return Twitch.ext.bits.purchase(product.sku);
      })
      .catch((err) => {
        console.error("Bits purchase failed:", err);
        showTempMessage("Bits purchase failed");
      });
  } catch (err) {
    console.error("Buy Bits failed:", err);
  }
}

// Bits receipt → verify with server
if (window.Twitch?.ext?.bits) {
  Twitch.ext.bits.onTransactionComplete((transaction) => {
    fetch(`https://gelly-server.onrender.com/v1/inventory/buy`, {
      method: "POST",
      headers: { Authorization: `Bearer ${twitchAuthToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: twitchUserId,
        itemId: transaction.product.sku,
        name: transaction.product.displayName,
        type: "unknown",
        cost: transaction.product.cost.amount,
        currency: "bits",
        transactionId: transaction.transactionId,
      }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.success) {
          showTempMessage(`Purchased ${transaction.product.displayName}!`);
          renderInventory(data.inventory || []);
          updateGellyImage(currentStage, currentColor);
          renderEquippedAccessories(data.inventory || []);
          animateGelly();
          fetchStore();
        } else {
          showTempMessage(data.message || "Bits purchase failed");
        }
      })
      .catch((err) => console.error("Transaction verification failed:", err));
  });
}

function updateColorPickerButtons() {
  const colorSelect = document.getElementById("gellyColor");
  if (colorSelect) {
    colorSelect.disabled = jellybeanBalance < COLOR_CHANGE_COST;
  }
}

// ===== Cooldown Tracking =====
const cooldowns = {};
function isOnCooldown(action) {
  return cooldowns[action] && Date.now() < cooldowns[action];
}
function setCooldown(action, ms) {
  cooldowns[action] = Date.now() + ms;
}

// ===== Jellybean Balance =====
async function fetchJellybeanBalance() {
  if (!loginName) return;
  try {
    const res = await fetch(`https://gelly-server.onrender.com/v1/points/${loginName}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    jellybeanBalance = data.points || 0;
    jellybeanBalanceEl.textContent = jellybeanBalance.toLocaleString();
    updateColorPickerButtons();
  } catch (err) {
    console.error("[ERROR] Failed to fetch jellybean balance:", err);
  }
}

// ===== State Updates =====
function updateUIFromState(state) {
  currentStage = state.stage;
  currentColor = state.color || currentColor;

  energyEl.textContent = Math.floor(state.energy);
  moodEl.textContent = Math.floor(state.mood);
  cleanlinessEl.textContent = Math.floor(state.cleanliness);

  updateGellyImage(state.stage, currentColor);

  if (state.stage !== "egg") {
    document.getElementById("openInventoryBtn").style.display = "inline-block";
    document.getElementById("openStoreBtn").style.display = "inline-block";

    if (Array.isArray(state.inventory)) {
      renderInventory(state.inventory);
    } else {
      fetchInventory(twitchUserId).then((data) => renderInventory(data.inventory || []));
    }
    fetchStore();
  } else {
    document.getElementById("openInventoryBtn").style.display = "none";
    document.getElementById("openStoreBtn").style.display = "none";
    document.getElementById("inventory-section").style.display = "none";
    document.getElementById("store-section").style.display = "none";
    clearEquippedAccessories();
  }
}

// Equipped overlays
function renderEquippedAccessories(inventory = []) {
  const gellyContainer = document.getElementById("background");
  document.querySelectorAll(".equipped-accessory").forEach((el) => el.remove());
  inventory.filter((item) => item.equipped).forEach((item) => {
    const img = document.createElement("img");
    img.src = `assets/${item.itemId}.png`;
    img.alt = item.name;
    img.className = `equipped-accessory type-${item.type || "accessory"}`;
    gellyContainer.appendChild(img);
  });
}
function clearEquippedAccessories() {
  document.querySelectorAll(".equipped-accessory").forEach((el) => el.remove());
}

// Leaderboard
function updateLeaderboard(entries) {
  leaderboardList.innerHTML = "";
  entries.forEach((entry) => {
    const li = document.createElement("li");
    li.textContent = `${entry.displayName || entry.loginName}: ${entry.score} care score`;
    leaderboardList.appendChild(li);
  });
}

// Interact
async function interact(action) {
  if (!twitchUserId || !twitchAuthToken) return;

  const ACTION_COOLDOWNS = { feed: 300000, clean: 240000, play: 180000, color: 60000 };
  const cooldownKey = action.startsWith("color:") ? "color" : action;
  const cooldownMs = ACTION_COOLDOWNS[cooldownKey] || 60000;
  const button =
    action === "feed" ? document.getElementById("feedBtn") :
    action === "play" ? document.getElementById("playBtn") :
    action === "clean" ? document.getElementById("cleanBtn") : null;

  if (isOnCooldown(cooldownKey)) return;

  try {
    const res = await fetch("https://gelly-server.onrender.com/v1/interact", {
      method: "POST",
      headers: { Authorization: `Bearer ${twitchAuthToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ user: twitchUserId, action }),
    });
    const data = await res.json();
    if (!data.success) {
      showTempMessage(data.message || "Action failed");
      return;
    }

    if (action === "feed" || action === "play" || action === "clean") triggerGellyAnimation(action);
    else if (action.startsWith("color:")) triggerColorChangeEffect();

    setCooldown(cooldownKey, cooldownMs);
    if (button) {
      const originalText = button.textContent;
      let remaining = Math.floor(cooldownMs / 1000);
      button.disabled = true;
      button.textContent = `${originalText} (${remaining}s)`;
      const interval = setInterval(() => {
        remaining -= 1;
        if (remaining > 0) button.textContent = `${originalText} (${remaining}s)`;
        else { clearInterval(interval); button.disabled = false; button.textContent = originalText; }
      }, 1000);
    }

    if (data.state) updateUIFromState(data.state);
    if (typeof data.newBalance === "number") {
      jellybeanBalance = data.newBalance;
      jellybeanBalanceEl.textContent = jellybeanBalance.toLocaleString();
      updateColorPickerButtons();
    } else {
      await fetchJellybeanBalance();
      updateColorPickerButtons();
    }
  } catch (err) {
    console.error("[ERROR] interact() failed:", err);
  }
}

// Init
async function initGame() {
  console.log("Starting game for user:", twitchUserId);
  try {
    const res = await fetch(`https://gelly-server.onrender.com/v1/state/${twitchUserId}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${twitchAuthToken}`, "Content-Type": "application/json" },
    });
    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        updateUIFromState(data.state);
        loginName = data.state.loginName;
        await fetchJellybeanBalance();
      }
    }
  } catch (err) {
    console.error("[ERROR] Fetching state failed:", err);
  }
  connectWebSocket();
  startGame();
}

function startGame() {
  const startScreen = document.getElementById("landing-page");
  const gameScreen = document.getElementById("gelly-container");
  if (!startScreen || !gameScreen) return;
  startScreen.style.display = "none";
  gameScreen.style.display = "block";
}

// WebSocket
let ws;
function connectWebSocket() {
  if (!twitchUserId) return;
  ws = new WebSocket(`wss://gelly-server.onrender.com?user=${twitchUserId}`);
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "update") updateUIFromState(msg.state);
    else if (msg.type === "leaderboard") updateLeaderboard(msg.entries);
  };
}

// Twitch Auth
Twitch.ext.onAuthorized(function (auth) {
  console.log("Authorized with ID:", auth.userId);
  twitchUserId = auth.userId;
  twitchAuthToken = auth.token;
  startKeepAlive();

  if (twitchUserId.startsWith("U") && localStorage.getItem("linkedOnce") !== "true") {
    showLinkButton();
    return;
  }
  initGame();
});

function startKeepAlive() {
  setInterval(() => {
    fetch("https://gelly-server.onrender.com/ping")
      .then((res) => res.json())
      .then((data) => console.log("Keep-alive ping:", data.message))
      .catch((err) => console.warn("Keep-alive failed:", err));
  }, 50000);
}

// Buttons
safeBind("feedBtn", "click", () => interact("feed"));
safeBind("playBtn", "click", () => interact("play"));
safeBind("cleanBtn", "click", () => interact("clean"));
safeBind("startGameBtn", "click", () => initGame());

// Help
safeBind("helpBtn", "click", () => {
  const helpBox = document.getElementById("help-box");
  const helpBtn = document.getElementById("helpBtn");
  if (helpBox && helpBtn) {
    const open = helpBox.style.display === "block";
    helpBox.style.display = open ? "none" : "block";
    helpBtn.textContent = open ? "Help" : "Close Help";
  }
});

// Color buttons
document.querySelectorAll(".color-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const selectedColor = btn.dataset.color;
    currentColor = selectedColor;
    interact(`color:${selectedColor}`);
    triggerColorChangeEffect();
    updateGellyImage(currentStage, currentColor);
  });
});
