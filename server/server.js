// ===== Gelly Server =====
const express = require("express");
const mongoose = require("mongoose");
const WebSocket = require("ws");
require("dotenv").config();
const Gelly = require("./Gelly.js");
const jwt = require("jsonwebtoken");
const tmi = require("tmi.js");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(express.json());

// ===== CORS (defensive, parser-free) =====
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

// tiny req logger
app.use((req, _res, next) => { console.log(`[REQ] ${req.method} ${req.path}`); next(); });

// ===== Twitch Bot =====
const twitchClient = new tmi.Client({
  identity: { username: process.env.TWITCH_BOT_USERNAME, password: process.env.TWITCH_OAUTH_TOKEN },
  channels: [process.env.TWITCH_CHANNEL_NAME],
});
twitchClient.connect().then(() => console.log("✅ Connected to Twitch chat as", process.env.TWITCH_BOT_USERNAME)).catch(console.error);

// ===== MongoDB =====
mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
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
    if (userId) { clients.delete(userId); console.log(`❌ WebSocket disconnected for user: ${userId}`); }
  });
});

function broadcastState(userId, gelly) {
  const ws = clients.get(userId);
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "update", state: gelly }));
}

async function sendLeaderboard() {
  const gellys = await Gelly.find();
  for (const g of gellys) {
    if (typeof g.applyDecay === "function") { g.applyDecay(); await g.save(); }
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

  const payload = JSON.stringify({ type: "leaderboard", entries: leaderboard });
  for (const [, s] of clients) if (s.readyState === WebSocket.OPEN) s.send(payload);
}

// ===== Helpers =====
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_APP_ACCESS_TOKEN = process.env.TWITCH_APP_ACCESS_TOKEN;
const STREAM_ELEMENTS_API = "https://api.streamelements.com/kappa/v2/points";
const STREAM_ELEMENTS_JWT = process.env.STREAMELEMENTS_JWT;
const STREAM_ELEMENTS_CHANNEL_ID = process.env.STREAMELEMENTS_CHANNEL_ID;
const ALLOW_GUEST_PURCHASES = process.env.ALLOW_GUEST_PURCHASES === "true";

function resolveTwitchId(authHeader, fallback) {
  try {
    const token = authHeader?.split(" ")[1];
    if (!token) return fallback;
    const decoded = jwt.decode(token);
    // Prefer opaque id so ALL panel calls hit the same doc (U…).
    const id = decoded?.opaque_user_id || decoded?.user_id || fallback;
    return (typeof id === "string" && id.trim()) ? id.trim() : fallback;
  } catch {
    return fallback;
  }
}

async function fetchTwitchUserData(userId) {
  try {
    const cleanId = userId?.startsWith("U") ? userId.substring(1) : userId;
    const res = await fetch(`https://api.twitch.tv/helix/users?id=${cleanId}`, {
      headers: { "Client-ID": TWITCH_CLIENT_ID, "Authorization": `Bearer ${TWITCH_APP_ACCESS_TOKEN}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const u = data?.data?.[0];
    return u ? { displayName: u.display_name, loginName: u.login } : null;
  } catch { return null; }
}
function getRealTwitchId(authHeader) {
  if (!authHeader) return null;
  try { return (jwt.decode(authHeader.split(" ")[1])?.user_id) || null; } catch { return null; }
}
async function fetchWithTimeout(makeReq, ms = 2500) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
  try { const r = await makeReq(ctrl.signal); clearTimeout(t); return r; } finally { clearTimeout(t); }
}
async function getUserPoints(username) {
  try {
    if (!username || username === "guest" || username === "unknown") return 0;
    const url = `${STREAM_ELEMENTS_API}/${STREAM_ELEMENTS_CHANNEL_ID}/${encodeURIComponent(username)}`;
    const res = await fetchWithTimeout(
      (signal) => fetch(url, { headers: { Authorization: `Bearer ${STREAM_ELEMENTS_JWT}` }, signal }),
      2500
    );
    if (!res.ok) return 0;
    const data = await res.json();
    return typeof data?.points === "number" ? data.points : 0;
  } catch { return 0; }
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
  } catch { return null; }
}

// inventory normalization & doc merge
function normalizeInventory(arr) {
  const seen = new Set();
  const out = [];
  for (const i of Array.isArray(arr) ? arr : []) {
    const id = (i.itemId || "").toString().trim();
    const key = id.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ itemId: id, name: i.name || "", type: i.type || "accessory", equipped: !!i.equipped });
  }
  // enforce one equipped per type
  const typeSeen = new Set();
  for (const it of out) {
    if (!it.equipped) continue;
    if (typeSeen.has(it.type)) it.equipped = false;
    else typeSeen.add(it.type);
  }
  return out;
}
async function mergeUserDocsIfSplit(primaryId) {
  const altId = primaryId.startsWith("U") ? primaryId.slice(1) : `U${primaryId}`;
  const [primary, alt] = await Promise.all([
    Gelly.findOne({ userId: primaryId }),
    Gelly.findOne({ userId: altId }),
  ]);
  if (!primary && !alt) return new Gelly({ userId: primaryId, points: 0, inventory: [] });
  if (primary && !alt) { primary.inventory = normalizeInventory(primary.inventory); await primary.save(); return primary; }
  if (!primary && alt) {
    alt.inventory = normalizeInventory(alt.inventory);
    alt.userId = primaryId; // migrate to canonical
    await alt.save();
    return alt;
  }
  // both exist → merge into primary
  const have = new Set(normalizeInventory(primary.inventory).map(i => i.itemId.toLowerCase()));
  for (const i of normalizeInventory(alt.inventory)) {
    if (!have.has(i.itemId.toLowerCase())) primary.inventory.push(i);
  }
  primary.inventory = normalizeInventory(primary.inventory);
  await primary.save();
  // optionally: await Gelly.deleteOne({ _id: alt._id });
  return primary;
}

// ===== Store (source of truth) =====
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
app.get("/v1/state/:userId", async (req, res) => {
  try {
    let { userId } = req.params;
    const realId = getRealTwitchId(req.headers.authorization);
    if (realId) userId = realId;

    let gelly = await mergeUserDocsIfSplit(userId);
    if (!gelly) gelly = new Gelly({ userId, points: 0 });

    if (typeof gelly.applyDecay === "function") gelly.applyDecay();

    if (!userId || userId.startsWith("U")) {
      gelly.displayName = "Guest Viewer"; gelly.loginName = "guest";
    } else {
      const td = await fetchTwitchUserData(userId);
      if (td) { gelly.displayName = td.displayName; gelly.loginName = td.loginName; }
    }

    await gelly.save();
    broadcastState(userId, gelly);
    res.json({ success: true, state: gelly });
  } catch (e) {
    console.error("[/v1/state] error", e);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.get("/v1/points/:username", async (req, res) => {
  try { res.json({ success: true, points: await getUserPoints(req.params.username) }); }
  catch { res.status(500).json({ success: false, points: 0 }); }
});

// ---- Interact ----
app.post("/v1/interact", async (req, res) => {
  try {
    let { user, action } = req.body;
    const realId = getRealTwitchId(req.headers.authorization);
    if (realId) user = realId;
    if (!user) return res.json({ success: false, message: "Missing user ID" });

    let gelly = await mergeUserDocsIfSplit(user);
    if (!gelly) gelly = new Gelly({ userId: user, points: 0 });
    if (typeof gelly.applyDecay === "function") gelly.applyDecay();

    if (!user || user.startsWith("U")) {
      gelly.displayName = "Guest Viewer"; gelly.loginName = "guest";
    } else {
      const td = await fetchTwitchUserData(user);
      if (td) { gelly.displayName = td.displayName; gelly.loginName = td.loginName; }
    }
    await gelly.save();

    const usernameForPoints = gelly.loginName;
    let userPoints = await getUserPoints(usernameForPoints);

    const ACTION_COOLDOWNS = { feed: 300000, clean: 240000, play: 180000, color: 60000 };
    const key = action.startsWith("color:") ? "color" : action;
    const cooldown = ACTION_COOLDOWNS[key] || 60000;
    const now = new Date();
    const last = gelly.lastActionTimes?.get?.(key) || null;
    if (last && now - last < cooldown) {
      const remaining = Math.ceil((cooldown - (now - last)) / 1000);
      return res.json({ success: false, message: `Please wait ${remaining}s before ${key} again.` });
    }
    gelly.lastActionTimes?.set?.(key, now);

    let ok = false;
    if (action === "feed") {
      const cost = 10000;
      if (userPoints < cost) return res.json({ success: false, message: "Not enough Jellybeans to feed." });
      const nb = await deductUserPoints(usernameForPoints, cost);
      if (nb === null) return res.json({ success: false, message: "Point deduction failed. Try again." });
      userPoints = nb;
      ok = gelly.updateStats("feed").success;
    } else if (action.startsWith("color:")) {
      const cost = 50000;
      if (userPoints < cost) return res.json({ success: false, message: "Not enough Jellybeans to change color." });
      const nb = await deductUserPoints(usernameForPoints, cost);
      if (nb === null) return res.json({ success: false, message: "Point deduction failed. Try again." });
      userPoints = nb;
      gelly.color = action.split(":")[1] || "blue";
      ok = true;
    } else if (action === "play") {
      ok = gelly.updateStats("play").success;
    } else if (action === "clean") {
      ok = gelly.updateStats("clean").success;
    } else if (action === "startgame") {
      gelly.points = 0; gelly.energy = 100; gelly.mood = 100; gelly.cleanliness = 100; gelly.stage = "egg"; gelly.lastUpdated = new Date();
      ok = true;
    } else {
      return res.json({ success: false, message: "Unknown action" });
    }

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

// ---- Inventory (read) ----
app.get("/v1/inventory/:userId", async (req, res) => {
  try {
    let { userId } = req.params;
    const realId = getRealTwitchId(req.headers.authorization);
    if (realId) userId = realId;

    let gelly = await mergeUserDocsIfSplit(userId);
    if (!gelly) gelly = new Gelly({ userId, points: 0, inventory: [] });
    if (typeof gelly.applyDecay === "function") gelly.applyDecay();
    await gelly.save();

    broadcastState(userId, gelly);
    res.json({ success: true, inventory: gelly.inventory || [] });
  } catch (err) {
    console.error("[ERROR] GET /v1/inventory:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ---- Buy (atomic add; avoids overwriting) ----
app.post("/v1/inventory/buy", async (req, res) => {
  try {
    const userId = resolveTwitchId(req.headers.authorization, req.body.userId);
    const { itemId, transactionId } = req.body;

    // canonical/merged doc
    let gelly = await mergeUserDocsIfSplit(userId);
    if (!gelly) gelly = await Gelly.create({ userId, points: 0, inventory: [] });

    // ensure twitch identities if possible
    if (!gelly.loginName || gelly.loginName === "unknown") {
      if (!userId.startsWith("U")) {
        const td = await fetchTwitchUserData(userId);
        if (td) { gelly.displayName = td.displayName; gelly.loginName = td.loginName; }
      }
      if (!gelly.loginName) { gelly.displayName = "Guest Viewer"; gelly.loginName = "guest"; }
      await gelly.save();
    }

    // validate item
    const storeItem = storeItems.find(s => s.id === itemId);
    if (!storeItem) return res.json({ success: false, message: "Invalid store item" });

    const { name, type, cost, currency } = storeItem;

    // payment checks
    if (currency === "jellybeans") {
      const isGuest = !gelly.loginName || gelly.loginName === "guest" || gelly.loginName === "unknown";
      if (!(isGuest && ALLOW_GUEST_PURCHASES)) {
        const usernameForPoints = gelly.loginName || "guest";
        const userPoints = await getUserPoints(usernameForPoints);
        if (userPoints < cost) return res.json({ success: false, message: "Not enough Jellybeans" });
        const newBal = await deductUserPoints(usernameForPoints, cost);
        if (newBal === null) return res.json({ success: false, message: "Point deduction failed" });
      }
    } else if (currency === "bits") {
      const valid = await verifyBitsTransaction(transactionId, userId.startsWith("U") ? userId.slice(1) : userId);
      if (!valid) return res.json({ success: false, message: "Bits payment not verified" });
    } else {
      return res.json({ success: false, message: "Invalid currency type" });
    }

    // atomic add (no duplicates)
    await Gelly.updateOne(
      { userId },
      { $addToSet: { inventory: { itemId, name, type, equipped: false } } }
    );

    const updated = await mergeUserDocsIfSplit(userId);
    console.log("[BUY] Added:", { userId: userId.replace(/^U/, ""), itemId });
    broadcastState(userId, updated);
    sendLeaderboard();

    return res.json({ success: true, inventory: updated.inventory || [] });
  } catch (err) {
    console.error("[ERROR] POST /v1/inventory/buy:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ---- Equip (merge first, then enforce one-per-type) ----
app.post("/v1/inventory/equip", async (req, res) => {
  try {
    const userId = resolveTwitchId(req.headers.authorization, req.body.userId);
    const { itemId, equipped } = req.body;

    let gelly = await mergeUserDocsIfSplit(userId);
    if (!gelly) return res.json({ success: false, message: "User not found" });

    const norm = (s) => (s ?? "").toString().trim().toLowerCase();
    const want = norm(itemId);

    // find by itemId, or by name
    let item = (gelly.inventory || []).find(i => norm(i.itemId) === want) ||
               (gelly.inventory || []).find(i => norm(i.name) === want);

    // if missing, try another merge (covers race)
    if (!item) {
      gelly = await mergeUserDocsIfSplit(userId);
      item = (gelly.inventory || []).find(i => norm(i.itemId) === want) ||
             (gelly.inventory || []).find(i => norm(i.name) === want);
    }

    if (!item) {
      console.warn("[EQUIP] Item not found", { userId: userId.replace(/^U/, ""), want, inv: (gelly.inventory || []).map(i => i.itemId) });
      return res.json({ success: false, message: "Item not found" }); // 200 so the panel can show message
    }

    // only one equipped per type
    if (equipped) {
      gelly.inventory.forEach(i => {
        if (i.type === item.type && norm(i.itemId) !== norm(item.itemId)) i.equipped = false;
      });
    }
    item.equipped = !!equipped;

    gelly.inventory = normalizeInventory(gelly.inventory);
    await gelly.save();

    console.log("[EQUIP] Updated", { userId: userId.replace(/^U/, ""), itemId: item.itemId, equipped: !!equipped });
    return res.json({ success: true, inventory: gelly.inventory });
  } catch (err) {
    console.error("[ERROR] POST /v1/inventory/equip:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// Debug probe
app.get(/^\/v1\/inventory\/equip\/?$/, (_req, res) => {
  res.json({ success: true, message: "equip endpoint alive; use POST" });
});

app.get("/v1/store", (_req, res) => res.json({ success: true, store: storeItems }));

// Health & Ping
app.get("/ping", (_req, res) => res.json({ success: true, message: "Server is awake" }));
app.get("/v1/ping", (_req, res) => res.json({ success: true, message: "Server is awake" }));

// Helpful 404 last
app.use((req, res) => {
  console.warn(`[404] ${req.method} ${req.originalUrl}`);
  res.status(404).json({ success: false, message: "Not Found", method: req.method, path: req.originalUrl });
});

// Bits verification
async function verifyBitsTransaction(transactionId, userId) {
  try {
    const res = await fetch(`https://api.twitch.tv/helix/extensions/transactions?id=${transactionId}`, {
      headers: { "Client-ID": process.env.TWITCH_CLIENT_ID, "Authorization": `Bearer ${process.env.TWITCH_APP_ACCESS_TOKEN}` }
    });
    if (!res.ok) return false;
    const data = await res.json();
    const tx = data.data && data.data[0];
    return !!(tx && tx.user_id === userId && tx.product_type === "BITS_IN_EXTENSION");
  } catch { return false; }
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
