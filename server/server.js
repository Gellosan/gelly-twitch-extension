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

// ===== Simple request log (why: quick visibility server-side) =====
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.path}`);
  next();
});

// ===== CORS (single source of truth) =====
function isAllowedOrigin(origin) {
  if (!origin) return true; // server-to-server, health checks, etc.
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

// ===== Twitch Bot Setup =====
const twitchClient = new tmi.Client({
  identity: {
    username: process.env.TWITCH_BOT_USERNAME,
    password: process.env.TWITCH_OAUTH_TOKEN,
  },
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
const WebSocketServer = new WebSocket.Server({ server });
const clients = new Map();

WebSocketServer.on("connection", (ws, req) => {
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

// Broadcast to both the provided id and its opaque/real counterpart.
// (Why: the panel connects with opaque U… even after identity is shared.)
function broadcastState(userId, gelly) {
  const id = String(userId || "");
  const keys = new Set([id]);
  if (id) {
    if (id.startsWith("U")) keys.add(id.slice(1));
    else keys.add(`U${id}`);
  }
  const payload = JSON.stringify({ type: "update", state: gelly });
  for (const k of keys) {
    const ws = clients.get(k);
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

async function sendLeaderboard() {
  const gellys = await Gelly.find();
  for (const g of gellys) {
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
    .filter((g) => g.loginName !== "guest" && g.loginName !== "unknown")
    .map((g) => ({
      displayName: g.displayName || g.loginName || "Unknown",
      loginName: g.loginName || "unknown",
      score: Math.floor((g.energy || 0) + (g.mood || 0) + (g.cleanliness || 0)),
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
    const cleanId = userId?.startsWith("U") ? userId.substring(1) : userId;
    const res = await fetch(`https://api.twitch.tv/helix/users?id=${cleanId}`, {
      headers: {
        "Client-ID": TWITCH_CLIENT_ID,
        Authorization: `Bearer ${TWITCH_APP_ACCESS_TOKEN}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const user = data?.data?.[0];
    return user ? { displayName: user.display_name, loginName: String(user.login || "").toLowerCase() } : null;
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

// ===== StreamElements API =====
const STREAM_ELEMENTS_API = "https://api.streamelements.com/kappa/v2/points";
const STREAM_ELEMENTS_JWT = process.env.STREAMELEMENTS_JWT;
const STREAM_ELEMENTS_CHANNEL_ID = process.env.STREAMELEMENTS_CHANNEL_ID;

async function getUserPoints(username) {
  try {
    const login = String(username || "").trim().toLowerCase();
    if (!login || login === "guest" || login === "unknown") return 0;
    const url = `${STREAM_ELEMENTS_API}/${STREAM_ELEMENTS_CHANNEL_ID}/${encodeURIComponent(login)}`;
    const res = await fetchWithTimeout(
      (signal) =>
        fetch(url, {
          headers: {
            Authorization: `Bearer ${STREAM_ELEMENTS_JWT}`,
            Accept: "application/json",
          },
          signal,
        }),
      2500
    );

    if (res.status === 404) return 0; // user has no points yet
    if (!res.ok) {
      console.error("[SE] getUserPoints failed:", res.status, await res.text().catch(() => ""));
      return 0;
    }
    const data = await res.json().catch(() => ({}));
    return typeof data?.points === "number" ? data.points : 0;
  } catch (err) {
    console.error("[SE] getUserPoints error:", err?.message || err);
    return 0;
  }
}

async function deductUserPoints(username, amount) {
  try {
    const login = String(username || "").trim().toLowerCase();
    const current = await getUserPoints(login);
    const newTotal = Math.max(0, current - Math.abs(amount));
    const cmd = `!setpoints ${login} ${newTotal}`;
    console.log("[IRC] →", cmd);
    twitchClient.say(process.env.TWITCH_CHANNEL_NAME, cmd);
    await new Promise((r) => setTimeout(r, 1500));
    return newTotal;
  } catch (err) {
    console.error("[deductUserPoints] error:", err);
    return null;
  }
}

// ===== API Routes =====

// NEW: initial state loader used by the panel
app.get("/v1/state/:userId", async (req, res) => {
  try {
    // Use the supplied id as the WS key, but enrich with real Twitch profile if available
    const supplied = String(req.params.userId || "");
    const real = getRealTwitchId(req.headers.authorization) || null;

    // Persist a doc for the supplied id (opaque or real) so the panel always has something to show
    let gelly = await Gelly.findOne({ userId: supplied });
    if (!gelly) gelly = new Gelly({ userId: supplied, points: 0, inventory: [] });

    if (typeof gelly.applyDecay === "function") gelly.applyDecay();

    // Fill in profile details:
    if (!supplied || supplied.startsWith("U")) {
      // guest/opaque
      gelly.displayName = "Guest Viewer";
      gelly.loginName = "guest";
    } else {
      const twitchData = await fetchTwitchUserData(supplied);
      if (twitchData) {
        gelly.displayName = twitchData.displayName;
        gelly.loginName = twitchData.loginName;
      }
    }

    await gelly.save();

    // Broadcast to whoever is connected under this id and its counterpart
    broadcastState(supplied, gelly);
    sendLeaderboard().catch(() => {});

    return res.json({ success: true, state: gelly });
  } catch (e) {
    console.error("[/v1/state] error:", e);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

app.get("/v1/points/by-user-id/:userId", async (req, res) => {
  try {
    // Prefer the real numeric Twitch ID from the extension JWT (only present if the viewer shared identity)
    const auth = req.headers.authorization || "";
    let realId = null;
    try { realId = jwt.decode(auth.split(" ")[1])?.user_id || null; } catch {}

    // Fallback: accept a numeric path param; reject opaque "U..." IDs
    if (!realId) {
      const candidate = String(req.params.userId || "");
      if (/^\d+$/.test(candidate)) realId = candidate;
    }

    if (!realId) {
      // We cannot resolve login without a real numeric ID; return 0 (viewer hasn’t shared identity)
      return res.json({ success: true, points: 0 });
    }

    // Try DB first, then Helix to map id -> login
    let login = null;
    const doc = await Gelly.findOne({ userId: realId }).lean();
    if (doc?.loginName) login = String(doc.loginName).toLowerCase();
    if (!login) {
      const uRes = await fetch(`https://api.twitch.tv/helix/users?id=${realId}`, {
        headers: {
          "Client-ID": process.env.TWITCH_CLIENT_ID,
          "Authorization": `Bearer ${process.env.TWITCH_APP_ACCESS_TOKEN}`,
          Accept: "application/json",
        }
      });
      if (uRes.ok) {
        const j = await uRes.json().catch(() => ({}));
        login = (j?.data?.[0]?.login || "").toLowerCase();
      }
    }

    if (!login) return res.json({ success: true, points: 0 });

    // StreamElements lookup by login
    const url = `https://api.streamelements.com/kappa/v2/points/${process.env.STREAMELEMENTS_CHANNEL_ID}/${encodeURIComponent(login)}`;
    const se = await fetch(url, {
      headers: { "Authorization": `Bearer ${process.env.STREAMELEMENTS_JWT}`, "Accept": "application/json" }
    });
    if (se.status === 404) return res.json({ success: true, points: 0 });
    if (!se.ok) return res.json({ success: true, points: 0 });
    const data = await se.json().catch(() => ({}));
    const points = typeof data?.points === "number" ? data.points : 0;
    return res.json({ success: true, points });
  } catch (e) {
    console.error("[/v1/points/by-user-id] error:", e);
    return res.status(500).json({ success: false, points: 0 });
  }
});

app.get("/v1/points/:username", async (req, res) => {
  try {
    const points = await getUserPoints(req.params.username);
    return res.json({ success: true, points });
  } catch {
    return res.status(500).json({ success: false, points: 0 });
  }
});

app.post("/v1/interact", async (req, res) => {
  try {
    let { user, action } = req.body;
    if (req.headers.authorization) {
      const realId = getRealTwitchId(req.headers.authorization);
      if (realId) user = realId; // prefer real id if available
    }
    if (!user) return res.json({ success: false, message: "Missing user ID" });

    let gelly = await Gelly.findOne({ userId: user });
    if (!gelly) gelly = new Gelly({ userId: user, points: 0, inventory: [] });

    if (typeof gelly.applyDecay === "function") gelly.applyDecay();

    if (!user || String(user).startsWith("U")) {
      gelly.displayName = "Guest Viewer";
      gelly.loginName = "guest";
    } else {
      const twitchData = await fetchTwitchUserData(user);
      if (twitchData) {
        gelly.displayName = twitchData.displayName;
        gelly.loginName = twitchData.loginName;
      }
    }

    // Ensure cooldown map exists and behaves like a Map
    if (!(gelly.lastActionTimes instanceof Map)) {
      const init = gelly.lastActionTimes && typeof gelly.lastActionTimes === "object"
        ? Object.entries(gelly.lastActionTimes)
        : [];
      gelly.lastActionTimes = new Map(init);
    }

    await gelly.save();
    const usernameForPoints = gelly.loginName;
    let userPoints = await getUserPoints(usernameForPoints);

    const ACTION_COOLDOWNS = { feed: 300000, clean: 240000, play: 180000, color: 60000 };
    const cooldownKey = String(action || "").startsWith("color:") ? "color" : action;
    const cooldown = ACTION_COOLDOWNS[cooldownKey] || 60000;
    const now = new Date();

    const last = gelly.lastActionTimes.get(cooldownKey);
    if (last && now - last < cooldown) {
      const remaining = Math.ceil((cooldown - (now - last)) / 1000);
      return res.json({ success: false, message: `Please wait ${remaining}s before ${cooldownKey} again.` });
    }
    gelly.lastActionTimes.set(cooldownKey, now);

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
    } else if (String(action).startsWith("color:")) {
      const cost = 50000;
      if (userPoints < cost) return res.json({ success: false, message: "Not enough Jellybeans to change color." });
      const newBal = await deductUserPoints(usernameForPoints, cost);
      if (newBal === null) return res.json({ success: false, message: "Point deduction failed. Try again." });
      userPoints = newBal;
      gelly.color = String(action).split(":")[1] || "blue";
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
      sendLeaderboard().catch(() => {});
      return res.json({ success: true, newBalance: userPoints, state: gelly });
    }
  } catch (err) {
    console.error("[ERROR] /v1/interact:", err);
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

    if (!Array.isArray(gelly.inventory)) gelly.inventory = [];
    if (typeof gelly.applyDecay === "function") gelly.applyDecay();

    await gelly.save();
    broadcastState(userId, gelly);
    return res.json({ success: true, inventory: gelly.inventory });
  } catch (err) {
    console.error("[ERROR] GET /v1/inventory:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

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

app.get("/v1/store", (_req, res) => {
  return res.json({ success: true, store: storeItems });
});

// ===== Buy Item =====
const AUTO_EQUIP_IF_EMPTY = false; // set true if you want first-of-type auto-equip
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
      }
    }
    if (!Array.isArray(gelly.inventory)) gelly.inventory = [];

    const storeItem = storeItems.find((s) => s.id === itemId);
    if (!storeItem) return res.json({ success: false, message: "Invalid store item" });

    name = storeItem.name;
    type = storeItem.type;
    cost = storeItem.cost;
    currency = storeItem.currency;

    if (currency === "jellybeans") {
      const usernameForPoints = gelly.loginName || "guest";
      const userPoints = await getUserPoints(usernameForPoints);
      if (userPoints < cost) return res.json({ success: false, message: "Not enough Jellybeans" });
      const newBal = await deductUserPoints(usernameForPoints, cost);
      if (newBal === null) return res.json({ success: false, message: "Point deduction failed" });
    } else if (currency === "bits") {
      const valid = await verifyBitsTransaction(transactionId, userId);
      if (!valid) return res.json({ success: false, message: "Bits payment not verified" });
    } else {
      return res.json({ success: false, message: "Invalid currency type" });
    }

    if (!gelly.inventory.some((i) => (i.itemId || "").toLowerCase() === itemId.toLowerCase())) {
      const newItem = { itemId, name, type, equipped: false };
      if (AUTO_EQUIP_IF_EMPTY && !gelly.inventory.some((i) => i.type === type && i.equipped)) {
        newItem.equipped = true;
      }
      gelly.inventory.push(newItem);
      console.log("[BUY] Added:", { userId: String(userId).replace(/^U/, ""), itemId });
    }

    await gelly.save();
    return res.json({ success: true, inventory: gelly.inventory });
  } catch (err) {
    console.error("[ERROR] POST /v1/inventory/buy:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ===== Equip Item =====
app.post("/v1/inventory/equip", async (req, res) => {
  try {
    let { userId, itemId, equipped } = req.body;
    if (req.headers.authorization) {
      const realId = getRealTwitchId(req.headers.authorization);
      if (realId) userId = realId;
    }
    const gelly = await Gelly.findOne({ userId });
    if (!gelly) return res.status(404).json({ success: false, message: "User not found" });

    if (!Array.isArray(gelly.inventory)) gelly.inventory = [];

    // robust matcher (why: avoid case/format mismatch between UI and DB)
    const norm = (s) => (s ?? "").toString().trim().toLowerCase();
    const want = norm(itemId);
    let item =
      gelly.inventory.find((i) => norm(i.itemId) === want) ||
      gelly.inventory.find((i) => norm(i.name) === want); // fallback by name

    if (!item) {
      console.warn("[EQUIP] Item not found for user", userId, "want:", itemId, "inv:", gelly.inventory);
      return res.status(404).json({ success: false, message: "Item not found" });
    }

    // Only one equipped per type
    if (equipped) {
      gelly.inventory.forEach((i) => {
        if (i.type === item.type && norm(i.itemId) !== norm(item.itemId)) i.equipped = false;
      });
    }
    item.equipped = !!equipped;

    await gelly.save();
    return res.json({ success: true, inventory: gelly.inventory });
  } catch (err) {
    console.error("[ERROR] POST /v1/inventory/equip:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

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

// Simple ping endpoint
app.get("/ping", (_req, res) => {
  return res.json({ success: true, message: "Server is awake" });
});

// ===== Bits verification =====
async function verifyBitsTransaction(transactionId, userId) {
  try {
    const res = await fetch(`https://api.twitch.tv/helix/extensions/transactions?id=${transactionId}`, {
      headers: {
        "Client-ID": process.env.TWITCH_CLIENT_ID,
        Authorization: `Bearer ${process.env.TWITCH_APP_ACCESS_TOKEN}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      console.error("Bits verification API failed", await res.text());
      return false;
    }
    const data = await res.json();
    const tx = data.data && data.data[0];
    return tx && String(tx.user_id) === String(userId) && (tx.product?.type || tx.product_type) === "BITS_IN_EXTENSION";
  } catch (err) {
    console.error("verifyBitsTransaction error:", err);
    return false;
  }
}

// ===== Start server =====
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
