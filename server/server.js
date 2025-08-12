// ===== Gelly Server =====
const express = require("express");
const mongoose = require("mongoose");
const WebSocket = require("ws");
require("dotenv").config();
const Gelly = require("./Gelly.js");
const jwt = require("jsonwebtoken");
const tmi = require("tmi.js");

// ----- App -----
const app = express();
app.use(express.json());

// Request log (why: visibility/debug in Render)
app.use((req, _res, next) => { console.log(`[REQ] ${req.method} ${req.path}`); next(); });

// ===== CORS tuned for Twitch (no URL() to avoid Invalid URL) =====
function isAllowedOrigin(origin) {
  if (!origin) return true;
  const host = origin.replace(/^https?:\/\//i, "").split("/")[0].toLowerCase();
  return (
    /\.ext-twitch\.tv$/.test(host) ||
    /\.twitch\.tv$/.test(host) ||
    host === "localhost" ||
    host.startsWith("localhost:") ||
    host === "127.0.0.1" ||
    host.startsWith("127.0.0.1:")
  );
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

// ===== Twitch Bot (for StreamElements points sync via chat) =====
const twitchClient = new tmi.Client({
  identity: { username: process.env.TWITCH_BOT_USERNAME, password: process.env.TWITCH_OAUTH_TOKEN },
  channels: [process.env.TWITCH_CHANNEL_NAME],
});
twitchClient.connect()
  .then(() => console.log("✅ Connected to Twitch chat as", process.env.TWITCH_BOT_USERNAME))
  .catch(console.error);

// ===== MongoDB =====
mongoose
  .connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ Mongo Error:", err));

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

// ===== Helpers =====
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_APP_ACCESS_TOKEN = process.env.TWITCH_APP_ACCESS_TOKEN;

// Consistent id: prefer JWT (shared identity user_id, else opaque U...), fallback to param/body
function resolveTwitchId(authHeader, fallback) {
  try {
    const token = authHeader?.split(" ")[1];
    if (!token) return fallback;
    const decoded = jwt.decode(token);
    const id = decoded?.user_id || decoded?.opaque_user_id;
    return (typeof id === "string" && id.trim()) ? id.trim() : fallback;
  } catch {
    return fallback;
  }
}

// Merge alt-id doc (opaque ↔ numeric) into resolved doc. Why: prevent split inventories.
async function mergeUserDocsIfSplit(primaryId) {
  const altId = primaryId.startsWith("U") ? primaryId.slice(1) : `U${primaryId}`;
  const [primary, alt] = await Promise.all([
    Gelly.findOne({ userId: primaryId }),
    Gelly.findOne({ userId: altId }),
  ]);
  if (!alt) return primary || null;

  let p = primary;
  if (!p) p = new Gelly({ userId: primaryId, points: 0, inventory: [] });

  // Merge unique items by itemId (case-insensitive)
  const have = new Set((p.inventory || []).map(i => (i.itemId || "").toLowerCase()));
  (alt.inventory || []).forEach(i => {
    const key = (i.itemId || "").toLowerCase();
    if (!have.has(key)) p.inventory.push({ itemId: i.itemId, name: i.name, type: i.type, equipped: false });
  });

  // Prefer better identity fields
  if (!p.displayName && alt.displayName) p.displayName = alt.displayName;
  if (!p.loginName && alt.loginName) p.loginName = alt.loginName;

  await p.save();
  return p;
}

async function fetchTwitchUserData(userId) {
  try {
    const cleanId = userId?.startsWith("U") ? userId.substring(1) : userId;
    const res = await fetch(`https://api.twitch.tv/helix/users?id=${cleanId}`, {
      headers: { "Client-ID": TWITCH_CLIENT_ID, Authorization: `Bearer ${TWITCH_APP_ACCESS_TOKEN}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const user = data?.data?.[0];
    return user ? { displayName: user.display_name, loginName: user.login } : null;
  } catch { return null; }
}

// Normalize Map( Date ) field even if old docs stored object
function toDateMap(maybeMap) {
  if (maybeMap instanceof Map) return maybeMap;
  const m = new Map();
  if (maybeMap && typeof maybeMap === "object") {
    for (const [k, v] of Object.entries(maybeMap)) m.set(k, new Date(v));
  }
  return m;
}

async function fetchWithTimeout(makeReq, ms = 2500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { const res = await makeReq(ctrl.signal); clearTimeout(timer); return res; }
  catch (e) { clearTimeout(timer); throw e; }
}

// ===== StreamElements points =====
const STREAM_ELEMENTS_API = "https://api.streamelements.com/kappa/v2/points";
const STREAM_ELEMENTS_JWT = process.env.STREAMELEMENTS_JWT;
const STREAM_ELEMENTS_CHANNEL_ID = process.env.STREAMELEMENTS_CHANNEL_ID;

async function getUserPoints(username) {
  try {
    if (!username || username === "guest" || username === "unknown") return 0;
    const url = `${STREAM_ELEMENTS_API}/${STREAM_ELEMENTS_CHANNEL_ID}/${encodeURIComponent(username)}`;
    const res = await fetchWithTimeout(
      (signal) => fetch(url, { headers: { Authorization: `Bearer ${STREAM_ELEMENTS_JWT}` }, signal }),
      2500
    );
    if (!res.ok) { console.error("[SE] getUserPoints failed:", await res.text()); return 0; }
    const data = await res.json();
    return typeof data?.points === "number" ? data.points : 0;
  } catch (err) { console.error("[SE] getUserPoints error:", err?.message || err); return 0; }
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
  } catch (err) { console.error("[deductUserPoints] error:", err); return null; }
}

async function sendLeaderboard() {
  const gellys = await Gelly.find();
  for (const g of gellys) {
    if (typeof g.applyDecay === "function") { g.applyDecay(); await g.save(); }
    if (!g.displayName || !g.loginName || g.loginName === "unknown") {
      const twitchData = await fetchTwitchUserData(g.userId);
      if (twitchData) { g.displayName = twitchData.displayName; g.loginName = twitchData.loginName; await g.save(); }
    }
  }
  const leaderboard = gellys
    .filter(g => g.loginName !== "guest" && g.loginName !== "unknown")
    .map(g => ({ displayName: g.displayName || g.loginName || "Unknown", loginName: g.loginName || "unknown",
      score: Math.floor((g.energy || 0) + (g.mood || 0) + (g.cleanliness || 0)) }))
    .sort((a,b)=>b.score-a.score).slice(0,10);

  const data = JSON.stringify({ type: "leaderboard", entries: leaderboard });
  for (const [, ws] of clients) if (ws.readyState === WebSocket.OPEN) ws.send(data);
}

// ===== Store catalog =====
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

// ===== API =====
app.get("/v1/store", (_req, res) => res.json({ success: true, store: storeItems }));

app.get("/v1/state/:userId", async (req, res) => {
  try {
    const userId = resolveTwitchId(req.headers.authorization, req.params.userId);
    let gelly = await mergeUserDocsIfSplit(userId);
    if (!gelly) gelly = new Gelly({ userId, points: 0, inventory: [] });

    if (typeof gelly.applyDecay === "function") gelly.applyDecay();

    if (!userId || userId.startsWith("U")) {
      gelly.displayName = "Guest Viewer"; gelly.loginName = "guest";
    } else {
      const twitchData = await fetchTwitchUserData(userId);
      if (twitchData) { gelly.displayName = twitchData.displayName; gelly.loginName = twitchData.loginName; }
    }

    await gelly.save();
    broadcastState(userId, gelly);
    res.json({ success: true, state: gelly });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: "Server error" }); }
});

app.get("/v1/points/:username", async (req, res) => {
  try { const points = await getUserPoints(req.params.username); res.json({ success: true, points }); }
  catch { res.status(500).json({ success: false, points: 0 }); }
});

app.post("/v1/interact", async (req, res) => {
  try {
    const user = resolveTwitchId(req.headers.authorization, req.body.user);
    const { action } = req.body;
    if (!user) return res.json({ success: false, message: "Missing user ID" });

    let gelly = await mergeUserDocsIfSplit(user);
    if (!gelly) gelly = new Gelly({ userId: user, points: 0, inventory: [] });

    if (typeof gelly.applyDecay === "function") gelly.applyDecay();

    if (!user || user.startsWith("U")) { gelly.displayName = "Guest Viewer"; gelly.loginName = "guest"; }
    else {
      const twitchData = await fetchTwitchUserData(user);
      if (twitchData) { gelly.displayName = twitchData.displayName; gelly.loginName = twitchData.loginName; }
    }

    await gelly.save();

    const usernameForPoints = gelly.loginName;
    let userPoints = await getUserPoints(usernameForPoints);

    // Cooldowns
    const ACTION_COOLDOWNS = { feed: 300000, clean: 240000, play: 180000, color: 60000 };
    const cooldownKey = action.startsWith("color:") ? "color" : action;
    const cooldown = ACTION_COOLDOWNS[cooldownKey] || 60000;
    const now = new Date();

    const times = toDateMap(gelly.lastActionTimes);
    const last = times.get(cooldownKey);
    if (last && now - last < cooldown) {
      const remaining = Math.ceil((cooldown - (now - last)) / 1000);
      return res.json({ success: false, message: `Please wait ${remaining}s before ${cooldownKey} again.` });
    }
    times.set(cooldownKey, now);
    gelly.lastActionTimes = times;

    let ok = false;
    if (action === "feed") {
      const cost = 10000;
      if (userPoints < cost) return res.json({ success: false, message: "Not enough Jellybeans to feed." });
      const newBal = await deductUserPoints(usernameForPoints, cost);
      if (newBal === null) return res.json({ success: false, message: "Point deduction failed. Try again." });
      userPoints = newBal;
      ok = gelly.updateStats("feed").success;
    } else if (action.startsWith("color:")) {
      const cost = 50000;
      if (userPoints < cost) return res.json({ success: false, message: "Not enough Jellybeans to change color." });
      const newBal = await deductUserPoints(usernameForPoints, cost);
      if (newBal === null) return res.json({ success: false, message: "Point deduction failed. Try again." });
      userPoints = newBal;
      gelly.color = action.split(":")[1] || "blue"; ok = true;
    } else if (action === "play") ok = gelly.updateStats("play").success;
    } else if (action === "clean") ok = gelly.updateStats("clean").success;
    else if (action === "startgame") {
      gelly.points = 0; gelly.energy = 100; gelly.mood = 100; gelly.cleanliness = 100;
      gelly.stage = "egg"; gelly.lastUpdated = new Date(); ok = true;
    } else return res.json({ success: false, message: "Unknown action" });

    if (!ok) return res.json({ success: false, message: "Action failed" });

    await gelly.save();
    broadcastState(user, gelly);
    sendLeaderboard();
    res.json({ success: true, newBalance: userPoints, state: gelly });
  } catch (err) {
    console.error("[ERROR] /v1/interact:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ===== Inventory =====
app.get("/v1/inventory/:userId", async (req, res) => {
  try {
    const userId = resolveTwitchId(req.headers.authorization, req.params.userId);
    let gelly = await mergeUserDocsIfSplit(userId);
    if (!gelly) gelly = new Gelly({ userId, points: 0, inventory: [] });
    if (!Array.isArray(gelly.inventory)) gelly.inventory = [];
    if (typeof gelly.applyDecay === "function") gelly.applyDecay();
    await gelly.save();
    broadcastState(userId, gelly);
    res.json({ success: true, inventory: gelly.inventory });
  } catch (err) {
    console.error("[ERROR] GET /v1/inventory:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

const AUTO_EQUIP_IF_EMPTY = false;

app.post("/v1/inventory/buy", async (req, res) => {
  try {
    let userId = resolveTwitchId(req.headers.authorization, req.body.userId);
    let { itemId, transactionId } = req.body;

    let gelly = await mergeUserDocsIfSplit(userId);
    if (!gelly) gelly = new Gelly({ userId, points: 0, inventory: [] });

    if (!gelly.loginName) {
      const twitchData = await fetchTwitchUserData(userId);
      if (twitchData) { gelly.displayName = twitchData.displayName; gelly.loginName = twitchData.loginName; }
    }
    if (!Array.isArray(gelly.inventory)) gelly.inventory = [];

    const storeItem = storeItems.find(s => s.id === itemId);
    if (!storeItem) return res.json({ success: false, message: "Invalid store item" });

    // charge user
    if (storeItem.currency === "jellybeans") {
      const usernameForPoints = gelly.loginName || "guest";
      const userPoints = await getUserPoints(usernameForPoints);
      if (userPoints < storeItem.cost) return res.json({ success: false, message: "Not enough Jellybeans" });
      const newBal = await deductUserPoints(usernameForPoints, storeItem.cost);
      if (newBal === null) return res.json({ success: false, message: "Point deduction failed" });
    } else if (storeItem.currency === "bits") {
      const ok = await verifyBitsTransaction(transactionId, userId);
      if (!ok) return res.json({ success: false, message: "Bits payment not verified" });
    } else return res.json({ success: false, message: "Invalid currency type" });

    // add once
    const exists = gelly.inventory.some(i => (i.itemId || "").toLowerCase() === itemId.toLowerCase());
    if (!exists) {
      const newItem = { itemId: storeItem.id, name: storeItem.name, type: storeItem.type, equipped: false };
      if (AUTO_EQUIP_IF_EMPTY && !gelly.inventory.some(i => i.type === storeItem.type && i.equipped)) {
        newItem.equipped = true;
      }
      gelly.inventory.push(newItem);
      console.log("[BUY] Added:", { userId, itemId: storeItem.id });
    }

    await gelly.save();
    res.json({ success: true, inventory: gelly.inventory });
  } catch (err) {
    console.error("[ERROR] POST /v1/inventory/buy:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.post("/v1/inventory/equip", async (req, res) => {
  try {
    const userId = resolveTwitchId(req.headers.authorization, req.body.userId);
    const { itemId, equipped } = req.body;

    let gelly = await mergeUserDocsIfSplit(userId);
    if (!gelly) return res.status(404).json({ success: false, message: "User not found" });

    if (!Array.isArray(gelly.inventory)) gelly.inventory = [];

    const norm = (s) => (s ?? "").toString().trim().toLowerCase();
    const want = norm(itemId);
    const byId = gelly.inventory.find(i => norm(i.itemId) === want);
    const byName = gelly.inventory.find(i => norm(i.name) === want);
    const item = byId || byName;

    if (!item) {
      console.warn("[EQUIP] Item not found", { userId, want, inv: gelly.inventory.map(i => i.itemId) });
      return res.status(404).json({ success: false, message: "Item not found" });
    }

    if (equipped) {
      gelly.inventory.forEach(i => {
        if (i.type === item.type && norm(i.itemId) !== norm(item.itemId)) i.equipped = false;
      });
    }
    item.equipped = !!equipped;

    await gelly.save();
    res.json({ success: true, inventory: gelly.inventory });
  } catch (err) {
    console.error("[ERROR] POST /v1/inventory/equip:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ===== Health =====
app.get("/ping", (_req, res) => res.json({ success: true, message: "Server is awake" }));

async function verifyBitsTransaction(transactionId, userId) {
  try {
    const res = await fetch(`https://api.twitch.tv/helix/extensions/transactions?id=${transactionId}`, {
      headers: { "Client-ID": process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${process.env.TWITCH_APP_ACCESS_TOKEN}` },
    });
    if (!res.ok) { console.error("Bits verification API failed", await res.text()); return false; }
    const data = await res.json();
    const tx = data.data && data.data[0];
    return tx && tx.user_id === userId && tx.product_type === "BITS_IN_EXTENSION";
  } catch (err) { console.error("verifyBitsTransaction error:", err); return false; }
}

// ===== Start =====
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
