// ===== Gelly Server =====
const express = require("express");
const mongoose = require("mongoose");
const WebSocket = require("ws");
require("dotenv").config();
const Gelly = require("./Gelly.js");
const jwt = require("jsonwebtoken");
const tmi = require("tmi.js");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const EXT_CLIENT_ID = process.env.TWITCH_EXTENSION_CLIENT_ID;
const EXT_APP_TOKEN = process.env.TWITCH_EXTENSION_APP_TOKEN;
const app = express();
app.use(express.json());

// ===== CORS =====
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
twitchClient.connect()
  .then(() => console.log("✅ Connected to Twitch chat as", process.env.TWITCH_BOT_USERNAME))
  .catch(console.error);

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
  const ws = clients.get(userId) || clients.get(`U${userId}`) || clients.get(String(userId).replace(/^U/, ""));
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "update", state: gelly }));
  }
}
function getRealTwitchId(authHeader) {
  if (!authHeader) return null;
  try { return jwt.decode(authHeader.split(" ")[1])?.user_id || null; } catch { return null; }
}
function canonicalUserId(authHeader, supplied) {
  const real = getRealTwitchId(authHeader);
  return real || supplied;
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

async function fetchTwitchUserData(userId) {
  try {
    const cleanId = String(userId || "").startsWith("U") ? String(userId).substring(1) : String(userId);
    const res = await fetch(`https://api.twitch.tv/helix/users?id=${cleanId}`, {
      headers: { "Client-ID": TWITCH_CLIENT_ID, "Authorization": `Bearer ${TWITCH_APP_ACCESS_TOKEN}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const u = data?.data?.[0];
    return u ? { displayName: u.display_name, loginName: u.login } : null;
  } catch { return null; }
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

// single definition
function normalizeInventory(arr) {
  const seen = new Set();
  const out = [];
  for (const i of Array.isArray(arr) ? arr : []) {
    const id = String(i.itemId || "").trim();
    if (!id) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ itemId: id, name: i.name || "", type: i.type || "accessory", equipped: !!i.equipped });
  }
  // one equipped per type
  const typed = new Set();
  for (const it of out) {
    if (!it.equipped) continue;
    if (typed.has(it.type)) it.equipped = false;
    else typed.add(it.type);
  }
  return out;
}

// merge docs
async function mergeUserDocs(userId) {
  const isReal = !String(userId).startsWith("U");
  if (!isReal) {
    let doc = await Gelly.findOne({ userId });
    if (!doc) doc = await Gelly.create({ userId, points: 0, inventory: [] });
    doc.inventory = normalizeInventory(doc.inventory);
    await doc.save();
    return doc;
  }

  const realId = userId;
  const opaqueId = `U${realId}`;

  let real = await Gelly.findOne({ userId: realId });
  let opaque = await Gelly.findOne({ userId: opaqueId });

  if (!real && !opaque) {
    real = await Gelly.create({ userId: realId, points: 0, inventory: [] });
    return real;
  }
  if (real && !opaque) {
    real.inventory = normalizeInventory(real.inventory);
    await real.save();
    return real;
  }
  if (!real && opaque) {
    opaque.userId = realId;
    opaque.inventory = normalizeInventory(opaque.inventory);
    await opaque.save();
    return opaque;
  }

  // both exist → merge
  const have = new Set(normalizeInventory(real.inventory).map(i => i.itemId.toLowerCase()));
  for (const it of normalizeInventory(opaque.inventory)) {
    if (!have.has(it.itemId.toLowerCase())) real.inventory.push(it);
  }
  real.inventory = normalizeInventory(real.inventory);
  await real.save();
  // optional: await Gelly.deleteOne({ _id: opaque._id });
  return real;
}

// ===== Store =====
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
    const userId = canonicalUserId(req.headers.authorization, req.params.userId);
    let gelly = await mergeUserDocs(userId);
    if (typeof gelly.applyDecay === "function") gelly.applyDecay();

    if (String(userId).startsWith("U")) {
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
    const userId = canonicalUserId(req.headers.authorization, req.body.user);
    const action = req.body.action;
    if (!userId) return res.json({ success: false, message: "Missing user ID" });

    let gelly = await mergeUserDocs(userId);
    if (typeof gelly.applyDecay === "function") gelly.applyDecay();

    if (String(userId).startsWith("U")) {
      gelly.displayName = "Guest Viewer";
      gelly.loginName = "guest";
    } else {
      const td = await fetchTwitchUserData(userId);
      if (td) { gelly.displayName = td.displayName; gelly.loginName = td.loginName; }
    }
    await gelly.save();

    const usernameForPoints = gelly.loginName || "guest";
    let userPoints = await getUserPoints(usernameForPoints);

    const ACTION_COOLDOWNS = { feed: 300000, clean: 240000, play: 180000, color: 60000 };
    const key = action?.startsWith?.("color:") ? "color" : action;
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
    } else if (action === "play") {
      ok = gelly.updateStats("play").success;
    } else if (action === "clean") {
      ok = gelly.updateStats("clean").success;
    } else if (action?.startsWith?.("color:")) {
      const cost = 50000;
      if (userPoints < cost) return res.json({ success: false, message: "Not enough Jellybeans to change color." });
      const nb = await deductUserPoints(usernameForPoints, cost);
      if (nb === null) return res.json({ success: false, message: "Point deduction failed. Try again." });
      userPoints = nb;
      gelly.color = action.split(":")[1] || "blue";
      ok = true;
    } else if (action === "startgame") {
      gelly.points = 0;
      gelly.energy = 100;
      gelly.mood = 100;
      gelly.cleanliness = 100;
      gelly.stage = "egg";
      gelly.lastUpdated = new Date();
      ok = true;
    } else {
      return res.json({ success: false, message: "Unknown action" });
    }

    if (!ok) return res.json({ success: false, message: "Action failed" });
    await gelly.save();

    broadcastState(userId, gelly);
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
    const userId = canonicalUserId(req.headers.authorization, req.params.userId);
    const gelly = await mergeUserDocs(userId);
    if (typeof gelly.applyDecay === "function") gelly.applyDecay();
    await gelly.save();
    broadcastState(userId, gelly);
    res.json({ success: true, inventory: gelly.inventory || [] });
  } catch (err) {
    console.error("[ERROR] GET /v1/inventory:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ---- Buy ----
app.post("/v1/inventory/buy", async (req, res) => {
  try {
    const userId = canonicalUserId(req.headers.authorization, req.body.userId);
    const { itemId, transactionId } = req.body;

    console.log("[BUY] incoming", { userId, itemId, transactionId });

    let gelly = await mergeUserDocs(userId);
    if (!gelly.loginName) {
      if (!String(userId).startsWith("U")) {
        const td = await fetchTwitchUserData(userId);
        if (td) { gelly.displayName = td.displayName; gelly.loginName = td.loginName; }
      }
      if (!gelly.loginName) { gelly.displayName = "Guest Viewer"; gelly.loginName = "guest"; }
      await gelly.save();
    }

    const storeItem = storeItems.find(s => s.id === itemId);
    if (!storeItem) return res.json({ success: false, message: "Invalid store item" });

    const { name, type, cost, currency } = storeItem;

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
      const verifyId = String(userId).startsWith("U") ? String(userId).slice(1) : String(userId);
      const valid = await verifyBitsTransaction(transactionId, verifyId);
      if (!valid) return res.json({ success: false, message: "Bits payment not verified" });
    } else {
      return res.json({ success: false, message: "Invalid currency type" });
    }

    await Gelly.updateOne(
      { userId },
      { $addToSet: { inventory: { itemId, name, type, equipped: false } } }
    );

    const updated = await mergeUserDocs(userId);
    updated.inventory = normalizeInventory(updated.inventory);
    await updated.save();

    console.log("[BUY] Added:", { userId: String(userId).replace(/^U/, ""), itemId });
    broadcastState(userId, updated);
    sendLeaderboard();
    res.json({ success: true, inventory: updated.inventory || [] });
  } catch (err) {
    console.error("[ERROR] POST /v1/inventory/buy:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ---- Equip ----
app.post("/v1/inventory/equip", async (req, res) => {
  try {
    const userId = canonicalUserId(req.headers.authorization, req.body.userId);
    const { itemId, equipped } = req.body;

    let gelly = await mergeUserDocs(userId);
    if (!gelly) return res.json({ success: false, message: "User not found" });

    const norm = (s) => (s ?? "").toString().trim().toLowerCase();
    const want = norm(itemId);

    let item = (gelly.inventory || []).find(i => norm(i.itemId) === want) ||
               (gelly.inventory || []).find(i => norm(i.name) === want);

    if (!item) {
      gelly = await mergeUserDocs(userId);
      item = (gelly.inventory || []).find(i => norm(i.itemId) === want) ||
             (gelly.inventory || []).find(i => norm(i.name) === want);
    }

    if (!item) {
      console.warn("[EQUIP] Item not found", { userId: String(userId).replace(/^U/, ""), want, inv: (gelly.inventory || []).map(i => i.itemId) });
      return res.json({ success: false, message: "Item not found" });
    }

    if (equipped) {
      gelly.inventory.forEach(i => {
        if (i.type === item.type && norm(i.itemId) !== norm(item.itemId)) i.equipped = false;
      });
    }
    item.equipped = !!equipped;

    gelly.inventory = normalizeInventory(gelly.inventory);
    await gelly.save();

    broadcastState(userId, gelly);
    return res.json({ success: true, inventory: gelly.inventory });
  } catch (err) {
    console.error("[ERROR] POST /v1/inventory/equip:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

app.get("/v1/store", (_req, res) => res.json({ success: true, store: storeItems }));

// Health
app.get("/ping", (_req, res) => res.json({ success: true, message: "Server is awake" }));
app.get("/v1/ping", (_req, res) => res.json({ success: true, message: "Server is awake" }));

// 404
app.use((req, res) => {
  console.warn(`[404] ${req.method} ${req.originalUrl}`);
  res.status(404).json({ success: false, message: "Not Found", method: req.method, path: req.originalUrl });
});

// Bits verification
// ---- Bits verification (Helix: Get Extension Transactions)
async function verifyBitsTransaction(transactionId, userId) {
  try {
    const url = `https://api.twitch.tv/helix/extensions/transactions?extension_id=${EXT_CLIENT_ID}&id=${transactionId}`;
    const res = await fetch(url, {
      headers: {
        'Client-ID': EXT_CLIENT_ID,
        'Authorization': `Bearer ${EXT_APP_TOKEN}`,
      }
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('[BITS] verify HTTP', res.status, JSON.stringify(data));
      return false;
    }
    const tx = data.data && data.data[0];
    return !!(tx &&
      tx.transaction_id === transactionId &&
      tx.user_id === userId &&
      tx.product_type === 'BITS_IN_EXTENSION');
  } catch (e) {
    console.error('[BITS] verify error', e);
    return false;
  }
}

    // Required: extension_id + id
    const params = new URLSearchParams({
      extension_id: EXT_CLIENT_ID,
      id: transactionId
    });

    const url = `https://api.twitch.tv/helix/extensions/transactions?${params.toString()}`;
    const res = await fetch(url, {
      headers: {
        "Client-ID": EXT_CLIENT_ID,                   // must be the Extension's client id
        "Authorization": `Bearer ${EXT_APP_TOKEN}`,   // app access token for the Extension
        "Content-Type": "application/json"
      }
    });

    const text = await res.text();
    if (!res.ok) {
      console.warn(`[BITS] verify HTTP ${res.status} ${text}`);
      return false;
    }

    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    const tx = data?.data?.[0];
    if (!tx) {
      console.warn("[BITS] verify: no transaction returned");
      return false;
    }

    // Accept either new or old shape: product.type OR product_type
    const productType = tx.product?.type || tx.product_type;
    const okUser = String(tx.user_id) === String(userId);
    const okType = productType === "BITS_IN_EXTENSION";

    if (!okUser || !okType) {
      console.warn("[BITS] verify: validation failed", { okUser, okType, txUser: tx.user_id, wantUser: String(userId), productType });
    }
    return okUser && okType;
  } catch (e) {
    console.error("[BITS] verify error:", e);
    return false;
  }
}



const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
