// ===== Gelly Server =====
const express = require("express");
const mongoose = require("mongoose");
const WebSocket = require("ws");
require("dotenv").config();
const Gelly = require("./Gelly.js");
const jwt = require("jsonwebtoken");
const tmi = require("tmi.js");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const path = require("path");
const EXT_CLIENT_ID = process.env.TWITCH_EXTENSION_CLIENT_ID;
const EXT_APP_TOKEN = process.env.TWITCH_EXTENSION_APP_TOKEN;

// ----- App -----
const app = express();
app.use(express.json());
app.use("/assets", express.static(path.join(__dirname, "assets"), {
  maxAge: "365d",
  immutable: true
}));
// ===== CORS (OBS + StreamElements safe) =====
function isAllowedOrigin(origin) {
  if (!origin) return "wildcard";            // Browser source may omit Origin → allow with "*"
  if (origin === "null") return "null";      // OBS Browser Source uses literal "null" string

  try {
    const host = origin.replace(/^https?:\/\//i, "").split("/")[0].toLowerCase();
    return (
      /\.ext-twitch\.tv$/.test(host) ||
      /\.twitch\.tv$/.test(host) ||
      /\.streamelements\.com$/.test(host) ||
      host === "localhost" ||
      host.startsWith("localhost:") ||
      host === "127.0.0.1" ||
      host.startsWith("127.0.0.1:")
    ) ? "exact" : false;
  } catch { return false; }
}

app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  const allow = isAllowedOrigin(origin);

  if (allow) {
    res.setHeader("Vary", "Origin");
    if (allow === "wildcard") {
      // No credentials with wildcard
      res.setHeader("Access-Control-Allow-Origin", "*");
    } else if (allow === "null") {
      // OBS Browser Source
      res.setHeader("Access-Control-Allow-Origin", "null");
      res.setHeader("Access-Control-Allow-Credentials", "true");
    } else {
      // Exact allow-list origin
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Requested-With");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});


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

// ----- Duel command config (declare BEFORE using) -----
const ENABLE_DUELS      = process.env.ENABLE_DUELS === "true";
const DUEL_CMD          = process.env.DUEL_CMD || "!gellyduel";
const DUEL_ACCEPT_CMD   = process.env.DUEL_ACCEPT_CMD || "!gellyaccept";
const DUEL_DECLINE_CMD  = process.env.DUEL_DECLINE_CMD || "!gellydecline"; // optional
const DUEL_MIN_BET      = Number(process.env.DUEL_MIN_BET || 1000);
const DUEL_MAX_BET      = Number(process.env.DUEL_MAX_BET || 500000);
const DUEL_TTL_MS       = Number(process.env.DUEL_TTL_MS || 60_000);
const DUEL_ALPHA        = Number(process.env.DUEL_ALPHA || 1.25);
const DUEL_CARE_PCT     = Number(process.env.DUEL_CARE_PCT || 0.01); // 1%

// pending challenges keyed by challenged login
const pendingDuels = new Map(); // targetLogin -> { challengerLogin, bet, createdAt }
const activeByUser = new Set(); // login names currently in a duel/challenge (prevents overlap)

function parseLogin(nameOrAt) {
  return String(nameOrAt || "").replace(/^@/, "").trim().toLowerCase();
}

function weightedWinProb(aCare, bCare) {
  const A = Math.max(1, Number(aCare) || 1);
  const B = Math.max(1, Number(bCare) || 1);
  const A2 = Math.pow(A, DUEL_ALPHA);
  const B2 = Math.pow(B, DUEL_ALPHA);
  return A2 / (A2 + B2);
}

async function setUserPoints(username, newTotal) {
  try {
    const total = Math.max(0, Math.floor(newTotal));
    const cmd = `!setpoints ${username} ${total}`;
    console.log("[IRC] →", cmd);
    twitchClient.say(process.env.TWITCH_CHANNEL_NAME, cmd);
    await new Promise(r => setTimeout(r, 1200));
    return true;
  } catch {
    return false;
  }
}
async function adjustUserPoints(username, delta) {
  const cur = await getUserPoints(username);
  const ok  = await setUserPoints(username, cur + delta);
  return ok ? (cur + delta) : null;
}

// Find gelly by login (create if missing)
async function getGellyByLogin(login) {
  let g = await Gelly.findOne({ loginName: login });
  if (!g) {
    g = await Gelly.create({
      userId: `guest-${login}`,
      loginName: login,
      displayName: login,
      energy: 100, mood: 100, cleanliness: 100,
      stage: "blob", color: "blue",
      inventory: []
    });
  }
  return g;
}

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
  const ws =
    clients.get(userId) ||
    clients.get(`U${userId}`) ||
    clients.get(String(userId).replace(/^U/, ""));
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

/** ---------- NEW: shared leaderboard builder (used by API + broadcaster) ---------- */
const _canonLogin = (s) => String(s || "").trim().toLowerCase();
function _isNumericUserId(uid) { return /^\d+$/.test(String(uid || "")); }
function _isGuestUserId(uid)   { return /^guest-/.test(String(uid || "")); }

function _pickBestDoc(a, b) {
  const aNum = _isNumericUserId(a.userId);
  const bNum = _isNumericUserId(b.userId);
  if (aNum !== bNum) return aNum ? a : b;

  const aGuest = _isGuestUserId(a.userId);
  const bGuest = _isGuestUserId(b.userId);
  if (aGuest !== bGuest) return bGuest ? a : b;

  const aAt = new Date(a.careMomentumUpdatedAt || a.updatedAt || 0).getTime();
  const bAt = new Date(b.careMomentumUpdatedAt || b.updatedAt || 0).getTime();
  if (aAt !== bAt) return aAt > bAt ? a : b;

  const aScore = Number(a.careScore || 0);
  const bScore = Number(b.careScore || 0);
  if (aScore !== bScore) return aScore > bScore ? a : b;

  const aCr = new Date(a.createdAt || 0).getTime();
  const bCr = new Date(b.createdAt || 0).getTime();
  if (aCr !== bCr) return aCr > bCr ? a : b;

  return String(a._id) > String(b._id) ? a : b;
}

function _dedupeByLogin(docs) {
  const map = new Map(); // login -> best doc
  for (const d of docs) {
    const login = _canonLogin(d.loginName || "");
    if (!login || login === "guest" || login === "unknown") continue;
    const cur = map.get(login);
    map.set(login, cur ? _pickBestDoc(cur, d) : d);
  }
  return Array.from(map.values());
}

async function buildLeaderboard() {
  // Pull lean docs for grouping
  const all = await Gelly.find().lean();

  // Group by canonical login & choose a single best doc per login
  const unique = _dedupeByLogin(all);

  // Refresh/decay only the winners we’ll actually display (and backfill names)
  const refreshed = [];
  for (const raw of unique) {
    const g = await Gelly.findById(raw._id);
    if (!g) continue;

    if (typeof g.applyDecay === "function") g.applyDecay(); // safe no-op if absent
    await updateCareScore(g, null); // decay-only (no event add)

    // Backfill login/display names if missing and we have a real numeric Twitch userId
    if ((!g.loginName || g.loginName === "unknown" || g.loginName === "guest") && _isNumericUserId(g.userId)) {
      const u = await fetchTwitchUserData(g.userId);
      if (u?.loginName) g.loginName = String(u.loginName).toLowerCase();
      if (u?.displayName) g.displayName = u.displayName;
    }

    await g.save();
    refreshed.push(g);
  }

  // Build, sort, slice
  const leaderboard = refreshed
    .map((g) => ({
      displayName: g.displayName || g.loginName || "Unknown",
      loginName:   _canonLogin(g.loginName || "unknown"),
      score:       Math.max(0, Math.round(g.careScore || 0)),
    }))
    .filter((e) => e.loginName && e.loginName !== "guest" && e.loginName !== "unknown")
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  return leaderboard;
}

/** ---------- existing broadcaster now uses builder (and returns entries) ---------- */
async function sendLeaderboard() {
  const leaderboard = await buildLeaderboard();
  const payload = JSON.stringify({ type: "leaderboard", entries: leaderboard });
  for (const [, s] of clients) {
    if (s.readyState === WebSocket.OPEN) s.send(payload);
  }
  return leaderboard;
}

async function flushLeaderboard(hard = false) {
  const cursor = Gelly.find().cursor();

  for (let g = await cursor.next(); g != null; g = await cursor.next()) {
    // Reset momentum; keep base stats (energy/mood/cleanliness) intact
    g.careMomentum = 0;
    g.careMomentumUpdatedAt = new Date();

    // Recompute careScore as base + 0 momentum
    await updateCareScore(g, null);
    if (hard) {
      // Optional: also normalize transient fields; DO NOT touch inventory
      // (You can add any additional "hard reset" semantics here if desired)
    }
    await g.save();
  }

  await sendLeaderboard();
}
app.post("/v1/leaderboard/flush", express.json(), async (req, res) => {
  try {
    const token = req.get("x-admin-token") || "";
    if (ADMIN_TOKEN && token !== ADMIN_TOKEN) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    const hard = !!(req.query.hard === "1" || req.body?.hard === true);
    await flushLeaderboard(hard);
    res.json({ success: true, hard });
  } catch (e) {
    console.error("[/v1/leaderboard/flush] error:", e);
    res.status(500).json({ success: false });
  }
});


// ===== Helpers =====
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_APP_ACCESS_TOKEN = process.env.TWITCH_APP_ACCESS_TOKEN;
const STREAM_ELEMENTS_API = "https://api.streamelements.com/kappa/v2/points";
const STREAM_ELEMENTS_JWT = process.env.STREAMELEMENTS_JWT;
const STREAM_ELEMENTS_CHANNEL_ID = process.env.STREAMELEMENTS_CHANNEL_ID;
const ALLOW_GUEST_PURCHASES = process.env.ALLOW_GUEST_PURCHASES === "true";
function _claims(authHeader) {
  try { return jwt.decode((authHeader || "").split(" ")[1]) || {}; } catch { return {}; }
}
async function resolveLoginSlug(slug) {
  // 1) Fast path: DB hit with lowercased slug
  const lc = String(slug || "").trim().toLowerCase();
  if (!lc) return null;

  // If doc already exists using this login, done.
  const doc = await Gelly.findOne({ loginName: lc }).lean();
  if (doc) return lc;

  // 2) Try Helix users?login= (covers DisplayName-with-different-casing)
  const uRes = await helixGet(`/users?login=${encodeURIComponent(lc)}`);
  if (uRes.ok) {
    const j = await uRes.json().catch(() => ({}));
    const u = j?.data?.[0];
    if (u?.login) return String(u.login).toLowerCase();
  }

  // 3) As a last resort: treat it as a valid login (Twitch logins are lowercase, no spaces)
  if (/^[a-z0-9_]{3,25}$/.test(lc)) return lc;

  return null;
}

async function fetchTwitchUserData(userId) {
  try {
    const cleanId = String(userId || "").startsWith("U") ? String(userId).substring(1) : String(userId);
    const res = await helixGet(`/users?id=${cleanId}`);
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    const u = data?.data?.[0];
    return u ? { displayName: u.display_name, loginName: u.login } : null;
  } catch { return null; }
}


async function fetchWithTimeout(makeReq, ms = 2500) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
  try { const r = await makeReq(ctrl.signal); clearTimeout(t); return r; } finally { clearTimeout(t); }
}
// ==== Leaderboard helpers (DEDUP + DEBOUNCE) ====
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ""; // set a secret for flush endpoint

// --- points cache (5s) to avoid SE thrash + rate limits
const _pointsCache = new Map(); // key: login -> { points, ts }
const POINTS_CACHE_MS = 5000;
const _normLogin = (u) => String(u || "").trim().replace(/^@/, "").toLowerCase();

async function getUserPoints(usernameRaw) {
  try {
    const username = _normLogin(usernameRaw);
    if (!username || username === "guest" || username === "unknown") return 0;

    const hit = _pointsCache.get(username);
    const now = Date.now();
    if (hit && (now - hit.ts) < POINTS_CACHE_MS) return hit.points;

    const url = `${STREAM_ELEMENTS_API}/${STREAM_ELEMENTS_CHANNEL_ID}/${encodeURIComponent(username)}`;

    // First attempt WITH Authorization
    let res = await fetchWithTimeout(
      (signal) => fetch(url, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${STREAM_ELEMENTS_JWT}`,
          "Accept": "application/json"
        },
        signal
      }),
      2500
    );

    // If auth is rejected, retry WITHOUT Authorization (public GET works on many SE setups)
    if (res.status === 401 || res.status === 403) {
      console.warn("[SE] points auth rejected (", res.status, ") for", username, "— retrying without Authorization");
      res = await fetchWithTimeout(
        (signal) => fetch(url, {
          method: "GET",
          headers: { "Accept": "application/json" },
          signal
        }),
        2500
      );
    }

    if (res.status === 404) { _pointsCache.set(username, { points: 0, ts: now }); return 0; }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn("[SE] points HTTP", res.status, body.slice(0, 200));
      return 0;
    }

    const data = await res.json().catch(() => ({}));
    const pts = (typeof data?.points === "number") ? data.points : 0;
    _pointsCache.set(username, { points: pts, ts: now });
    return pts;
  } catch (e) {
    console.warn("[SE] points error:", e?.message || e);
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
  } catch { return null; }
}
// helper to choose a body sprite URL based on stage+color
function spriteUrlFor(g) {
  const color = (g.color || "blue").toLowerCase();   // blue|green|pink
  const stage = (g.stage || "blob").toLowerCase();   // egg|blob|gelly
  if (stage === "egg")  return `/assets/egg.png`;
  if (stage === "blob") return `/assets/blob-${color}.png`;
  return `/assets/gelly-${color}.png`;
}

// helper to choose accessory sprite URL based on item id (adds .src to each equipped item)
function accSpriteFor(item, g) {
  const id = String(item.itemId || item.id || "").toLowerCase();
  if (id === "sparkles") return `/assets/sparkles.gif`;
  return `/assets/${encodeURIComponent(id)}.png`;
}

// GET /v1/overlay/gelly/by-login/:login
// Helpers to ensure absolute URLs in overlay responses
function absUrlFor(req, p) {
  // p can be '/assets/hat.png'
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host  = req.headers['x-forwarded-host']  || req.headers.host;
  return /^https?:\/\//i.test(p) ? p : `${proto}://${host}${p.startsWith('/') ? '' : '/'}${p}`;
}

app.get("/v1/overlay/gelly/by-login/:login", async (req, res) => {
  try {
    const login = String(req.params.login || "").trim().toLowerCase();
    if (!login) return res.status(400).json({ success: false, message: "missing login" });

    const candidates = await Gelly.find({ loginName: login }).lean();
    const pick = candidates.find(d => /^\d+$/.test(String(d.userId || "")))
             || candidates.find(d => !String(d.userId || "").startsWith("guest-"))
             || candidates[0] || null;

    if (!pick) {
      return res.json({
        success: true,
        gelly: {
          displayName: login, loginName: login,
          color: "blue", stage: "blob", careScore: 0,
          equipped: [],
          spriteUrl: absUrlFor(req, "/assets/blob-blue.png"),
        }
      });
    }

    const g = await Gelly.findById(pick._id);
    if (typeof g.applyDecay === "function") g.applyDecay();
    await updateCareScore(g, null);
    await g.save();

const equipped = (g.inventory || [])
  .filter(i => i.equipped)
  .filter(i =>
    String(i.type || "").toLowerCase() !== "background" &&
    !/^background(\d+)?$/i.test(String(i.itemId || i.name || ""))
  )
  .map(i => ({ ...i, src: absUrlFor(req, accSpriteFor(i, g)) }));

    return res.json({
      success: true,
      gelly: {
        displayName: g.displayName || login,
        loginName: login,
        color: g.color || "blue",
        stage: g.stage || "blob",
        careScore: g.careScore || 0,
        equipped,
        spriteUrl: absUrlFor(req, spriteUrlFor(g)), // <-- ABSOLUTE
      }
    });
  } catch (e) {
    console.error("[/v1/overlay/gelly/by-login] error:", e);
    return res.status(500).json({ success: false });
  }
});




// ---- Twitch App Token Manager ----
let _appToken = process.env.TWITCH_APP_ACCESS_TOKEN || "";
let _appTokenExp = 0; // epoch ms

async function refreshAppToken() {
  const params = new URLSearchParams({
    client_id: process.env.TWITCH_CLIENT_ID,
    client_secret: process.env.TWITCH_CLIENT_SECRET,
    grant_type: "client_credentials",
  });
  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) {
    console.error("[TWITCH] app token refresh failed:", res.status, await res.text().catch(() => ""));
    return _appToken; // best effort
  }
  const j = await res.json();
  _appToken = j.access_token || "";
  _appTokenExp = Date.now() + Math.max(30, j.expires_in || 3600) * 1000;
  console.log("[TWITCH] refreshed app token; expires_in(s) =", j.expires_in);
  return _appToken;
}

async function getAppToken(force = false) {
  if (!force && _appToken && Date.now() < (_appTokenExp - 60_000)) return _appToken;
  return refreshAppToken();
}

async function helixGet(path) {
  // First try with current/seed token
  let token = await getAppToken(false);
  let res = await fetch(`https://api.twitch.tv/helix${path}`, {
    headers: { "Client-ID": process.env.TWITCH_CLIENT_ID, "Authorization": `Bearer ${token}` },
  });
  if (res.status === 401 || res.status === 403) {
    // Refresh and retry once
    token = await getAppToken(true);
    res = await fetch(`https://api.twitch.tv/helix${path}`, {
      headers: { "Client-ID": process.env.TWITCH_CLIENT_ID, "Authorization": `Bearer ${token}` },
    });
  }
  return res;
}

// ===== Care Score config =====
const CARE_HALF_LIFE_HOURS = Number(process.env.CARE_HALF_LIFE_HOURS || 24); // faster decay
const CARE_WEIGHTS = (() => {
  try { return JSON.parse(process.env.CARE_WEIGHTS_JSON); }
  catch { return { feed: 6, play: 4, clean: 3 }; }
})();
const MOMENTUM_CAPS = {
  egg:   Number(process.env.CAP_MOMENTUM_EGG   || 300),
  blob:  Number(process.env.CAP_MOMENTUM_BLOB  || 1000),
  gelly: Number(process.env.CAP_MOMENTUM_GELLY || 2000),
};

function decayMomentum(prevMomentum = 0, lastAt, now = new Date()) {
  if (!prevMomentum || !lastAt) return { momentum: prevMomentum || 0, at: now };
  const elapsedMs = now - new Date(lastAt);
  if (elapsedMs <= 0) return { momentum: prevMomentum, at: now };
  const lambda = Math.log(2) / (CARE_HALF_LIFE_HOURS * 3600_000);
  const momentum = prevMomentum * Math.exp(-lambda * elapsedMs);
  return { momentum, at: now };
}

// Call this any time we show/modify state
async function updateCareScore(gelly, eventType /* 'feed'|'play'|'clean'|null */) {
  const now = new Date();

  // decay old momentum → add event points (if any)
  const decayed = decayMomentum(gelly.careMomentum || 0, gelly.careMomentumUpdatedAt, now).momentum;
  const add = eventType ? (CARE_WEIGHTS[eventType] || 0) : 0;
  const momentum = decayed + add;

  // base still tops out at 1500 on perfect stats
  const base = ((gelly.energy || 0) + (gelly.mood || 0) + (gelly.cleanliness || 0)) * 5;

  // clamp momentum by stage to slow explosive growth
  const stage = (gelly.stage || "egg").toLowerCase();
  const cap = MOMENTUM_CAPS[stage] ?? 1000;
  const clampedMomentum = Math.min(momentum, cap);

  gelly.careMomentum = clampedMomentum;
  gelly.careMomentumUpdatedAt = now;
  gelly.careScore = Math.round(base + clampedMomentum);
  return gelly.careScore;
}

// Inventory normalize
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

// Merge guest + real docs
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
  { id: "horns-blue",   name: "Blue Horns",   type: "hat",       cost: 300000, currency: "jellybeans" },
  { id: "horns-green",  name: "Green Horns",   type: "hat",      cost: 300000, currency: "jellybeans" },
  { id: "horns-pink",   name: "Pink Horns",   type: "hat",       cost: 300000, currency: "jellybeans" },
  { id: "ears-blue",    name: "Blue Ears",    type: "hat",       cost: 300000, currency: "jellybeans" },
  { id: "ears-pink",    name: "Pink Ears",    type: "hat",       cost: 300000, currency: "jellybeans" },
  { id: "ears-green",   name: "Green Ears",   type: "hat",       cost: 300000, currency: "jellybeans" },
  { id: "gold-crown",   name: "Gold Crown",   type: "hat",       cost: 100,    currency: "bits" },
  { id: "sword",        name: "Sword",        type: "weapon",    cost: 100,    currency: "bits" },
  { id: "king-crown",   name: "Royal Crown",  type: "hat",       cost: 100,    currency: "bits" },
  { id: "gun",          name: "M4",           type: "weapon",    cost: 100,    currency: "bits" },
  { id: "katana",       name: "Katana",       type: "weapon",    cost: 100,    currency: "bits" },
  { id: "background1", name: "Plains Background",   type: "background", cost: 500000, currency: "jellybeans" },
  { id: "background2", name: "Autumn Background",   type: "background", cost: 500000, currency: "jellybeans" },
  { id: "background3", name: "Cherry Blossoms",     type: "background", cost: 500000, currency: "jellybeans" },
  { id: "background4", name: "Beach Background",    type: "background", cost: 500000, currency: "jellybeans" },
  { id: "background5", name: "Mountain Background", type: "background", cost: 500000, currency: "jellybeans" },
];

// ===== API =====

// always return a state (guest or real); also merges guest→real when authorized later
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

    await updateCareScore(gelly, null);
    await gelly.save();
    broadcastState(userId, gelly);

    // Build entries for API response (and also broadcast for other clients)
    const entries = await sendLeaderboard();
    
    res.json({ success: true, state: gelly, leaderboard: entries });
  } catch (e) {
    console.error("[/v1/state] error", e);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// points by username (lowercased)
app.get("/v1/points/:username", async (req, res) => {
  try {
    const u = String(req.params.username || "").toLowerCase();
    res.json({ success: true, points: await getUserPoints(u) });
  } catch {
    res.status(500).json({ success: false, points: 0 });
  }
});

// points by numeric user id (read from JWT if present; falls back to path if numeric)
app.get("/v1/points/by-user-id/:userId", async (req, res) => {
  try {
    // Resolve real numeric id from JWT first, then fallback to :userId if numeric
    const auth = req.headers.authorization || "";
    let realId = null;
    try { realId = jwt.decode(auth.split(" ")[1])?.user_id || null; } catch {}
    if (!realId) {
      const candidate = String(req.params.userId || "");
      if (/^\d+$/.test(candidate)) realId = candidate;
    }
    if (!realId) return res.json({ success: true, points: 0 }); // guest/unlinked → 0

    // Find login → DB, else Helix (with auto-refreshing token)
    let login = null;
    const doc = await Gelly.findOne({ userId: realId }).lean();
    if (doc?.loginName) login = String(doc.loginName).toLowerCase();

    if (!login) {
      const uRes = await helixGet(`/users?id=${realId}`);
      if (uRes.ok) {
        const j = await uRes.json().catch(() => ({}));
        login = (j?.data?.[0]?.login || "").toLowerCase();
      } else {
        console.warn("[/v1/points/by-user-id] Helix lookup failed:", uRes.status);
      }
    }

    if (!login) return res.json({ success: true, points: 0 });

    // Delegate to the centralized SE fetcher (handles cache + retries)
    const points = await getUserPoints(login);
    return res.json({ success: true, points });
  } catch (e) {
    console.error("[/v1/points/by-user-id] error:", e);
    return res.status(500).json({ success: false, points: 0 });
  }
});
// GET /v1/leaderboard  → { success, entries: [{displayName, loginName, score}, ...] }
app.get("/v1/leaderboard", async (req, res) => {
  try {
    // Optional ?limit=#
    const n = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 10));

    // Build without broadcasting; slice here to honor ?limit
    const entriesAll = await buildLeaderboard();
    const entries = entriesAll.slice(0, n);

    // No caching; this changes frequently
    res.setHeader("Cache-Control", "no-store");
    return res.json({ success: true, entries });
  } catch (e) {
    console.error("[/v1/leaderboard] error:", e);
    return res.status(500).json({ success: false });
  }
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

    // Ensure cooldown map is usable
    if (!(gelly.lastActionTimes instanceof Map)) {
      const init = gelly.lastActionTimes && typeof gelly.lastActionTimes === "object"
        ? Object.entries(gelly.lastActionTimes)
        : [];
      gelly.lastActionTimes = new Map(init);
    }

    const usernameForPoints = gelly.loginName || "guest";
    let userPoints = await getUserPoints(usernameForPoints);

    const ACTION_COOLDOWNS = { feed: 300000, clean: 240000, play: 180000, color: 60000 };
    const key = action?.startsWith?.("color:") ? "color" : action;
    const cooldown = ACTION_COOLDOWNS[key] || 60000;

    const now = new Date();
    const last = gelly.lastActionTimes.get(key) || null;
    if (last && now - last < cooldown) {
      const remaining = Math.ceil((cooldown - (now - last)) / 1000);
      return res.json({ success: false, message: `Please wait ${remaining}s before ${key} again.` });
    }
    gelly.lastActionTimes.set(key, now);

    let ok = false;
    let awardedEvent = null;

    if (action === "feed") {
      const cost = 10000;
      if (userPoints < cost) return res.json({ success: false, message: "Not enough Jellybeans to feed." });
      const nb = await deductUserPoints(usernameForPoints, cost);
      if (nb === null) return res.json({ success: false, message: "Point deduction failed. Try again." });
      userPoints = nb;
      ok = gelly.updateStats("feed").success;
      awardedEvent = "feed";
    } else if (action === "play") {
      ok = gelly.updateStats("play").success;
      awardedEvent = "play";
    } else if (action === "clean") {
      ok = gelly.updateStats("clean").success;
      awardedEvent = "clean";
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

    // Update care score (adds momentum for feed/play/clean)
    await updateCareScore(gelly, awardedEvent);
    await gelly.save();

    broadcastState(userId, gelly);
    sendLeaderboard();
    return res.json({ success: true, newBalance: userPoints, state: gelly });
  } catch (err) {
    console.error("[ERROR] /v1/interact:", err);
    return res.status(500).json({ success: false, message: "Server error" });
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
      if (!transactionId) {
        return res.json({ success: false, message: "Missing Bits transaction id" });
      }
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

// ===== Duels (chat handlers) =====
function clearExpiredChallenges() {
  const now = Date.now();
  for (const [target, c] of pendingDuels.entries()) {
    if (now - c.createdAt > DUEL_TTL_MS) {
      pendingDuels.delete(target);
      activeByUser.delete(c.challengerLogin);
      activeByUser.delete(target);
    }
  }
}
setInterval(clearExpiredChallenges, 5000);

async function applyDuelCareDelta(gelly, pct /* e.g. +0.01 or -0.01 */) {
  const decayed = decayMomentum(gelly.careMomentum || 0, gelly.careMomentumUpdatedAt, new Date()).momentum;
  const currentScore = Math.max(0, Number(gelly.careScore) || 0);
  const delta = Math.round(currentScore * pct);

  let newMomentum = decayed + delta;
  if (newMomentum < 0) newMomentum = 0;

  gelly.careMomentum = newMomentum;
  gelly.careMomentumUpdatedAt = new Date();

  await updateCareScore(gelly, null);
  await gelly.save();
  return gelly.careScore;
}

if (ENABLE_DUELS) {
  twitchClient.on("message", async (channel, tags, msg, self) => {
    if (self) return;
    const text = (msg || "").trim();
    const low  = text.toLowerCase();
    const sender = parseLogin(tags.username);

    const isDuelCmd     = low.startsWith(DUEL_CMD);
    const isAcceptCmd   = low.startsWith(DUEL_ACCEPT_CMD);
    const isDeclineCmd  = low.startsWith(DUEL_DECLINE_CMD);

    if (!isDuelCmd && !isAcceptCmd && !isDeclineCmd) return;

    try {
      // --- !gellyduel @user 12345 ---
      if (isDuelCmd) {
        const rest = text.slice(DUEL_CMD.length).trim();
        const [rawTarget, betStr] = rest.split(/\s+/);
        const target = parseLogin(rawTarget);
        const betNum = parseInt(betStr, 10);
        const bet = Math.max(DUEL_MIN_BET, Math.min(DUEL_MAX_BET, isFinite(betNum) ? betNum : 0));

        if (!target) { twitchClient.say(channel, `@${sender} usage: ${DUEL_CMD} @username <bet>. Min ${DUEL_MIN_BET}, max ${DUEL_MAX_BET}.`); return; }
        if (sender === target) { twitchClient.say(channel, `@${sender} you can’t duel yourself 😅`); return; }
        if (activeByUser.has(sender) || activeByUser.has(target)) {
          twitchClient.say(channel, `@${sender} someone is already in a duel. Try again in a moment.`);
          return;
        }
        if (!bet || bet < DUEL_MIN_BET) { twitchClient.say(channel, `@${sender} minimum bet is ${DUEL_MIN_BET}.`); return; }

        const p1 = await getUserPoints(sender);
        const p2 = await getUserPoints(target);
        if (p1 < bet) { twitchClient.say(channel, `@${sender} you don’t have enough Jellybeans for a ${bet} bet.`); return; }
        if (p2 < bet) { twitchClient.say(channel, `@${sender} ${target} doesn’t have enough Jellybeans for ${bet}.`); return; }

        activeByUser.add(sender);
        activeByUser.add(target);
        pendingDuels.set(target, { challengerLogin: sender, bet, createdAt: Date.now() });

        twitchClient.say(
          channel,
          `@${target}, @${sender} has challenged you to a GELLY DUEL for ${bet} 🫘! ` +
          `Type ${DUEL_ACCEPT_CMD} to fight (${Math.round(DUEL_TTL_MS/1000)}s).`
        );
        return;
      }

      // --- !gellyaccept [@challenger] ---
      if (isAcceptCmd) {
        const rest = text.slice(DUEL_ACCEPT_CMD.length).trim();
        const maybeChallenger = parseLogin(rest.split(/\s+/)[0] || "");
        const challenge = pendingDuels.get(sender);

        if (!challenge) { twitchClient.say(channel, `@${sender} you don’t have a pending duel.`); return; }
        if (maybeChallenger && maybeChallenger !== challenge.challengerLogin) {
          twitchClient.say(channel, `@${sender} your pending challenger is @${challenge.challengerLogin}, not @${maybeChallenger}.`);
          return;
        }

        pendingDuels.delete(sender);

        const challenger = challenge.challengerLogin;
        const target = sender;
        const bet = challenge.bet;

        const g1 = await getGellyByLogin(challenger);
        const g2 = await getGellyByLogin(target);
        await updateCareScore(g1, null); await g1.save();
        await updateCareScore(g2, null); await g2.save();

        const p1 = await getUserPoints(challenger);
        const p2 = await getUserPoints(target);
        if (p1 < bet || p2 < bet) {
          twitchClient.say(channel, `Duel canceled: one of you no longer has ${bet} Jellybeans.`);
          activeByUser.delete(challenger); activeByUser.delete(target);
          return;
        }

        const cs1 = Number(g1.careScore || 0);
        const cs2 = Number(g2.careScore || 0);
        const probChallenger = weightedWinProb(cs1, cs2);
        const roll = Math.random();
        const winner = roll < probChallenger ? challenger : target;
        const loser  = winner === challenger ? target : challenger;

        await adjustUserPoints(winner, +bet);
        await adjustUserPoints(loser,  -bet);

        const gW = winner === challenger ? g1 : g2;
        const gL = winner === challenger ? g2 : g1;
        await applyDuelCareDelta(gW, +DUEL_CARE_PCT);
        await applyDuelCareDelta(gL, -DUEL_CARE_PCT);

        if (g1.userId) broadcastState(g1.userId, g1);
        if (g2.userId) broadcastState(g2.userId, g2);
        sendLeaderboard();

        const pretty = (n) => Math.round(n).toLocaleString();
        twitchClient.say(
          channel,
          `⚔️ Gelly Duel: @${challenger} (care ${pretty(cs1)}) vs @${target} (care ${pretty(cs2)}). ` +
          `Winner: @${winner}! +${bet}🫘 & +${Math.round(DUEL_CARE_PCT*100)}% care. @${loser} loses ${bet}🫘 & ${Math.round(DUEL_CARE_PCT*100)}% care.`
        );

        activeByUser.delete(challenger); activeByUser.delete(target);
        return;
      }

      // --- !gellydecline (optional) ---
      if (isDeclineCmd) {
        const challenge = pendingDuels.get(sender);
        if (!challenge) { twitchClient.say(channel, `@${sender} you don’t have a pending duel.`); return; }
        pendingDuels.delete(sender);
        activeByUser.delete(sender);
        activeByUser.delete(challenge.challengerLogin);
        twitchClient.say(channel, `@${sender} declined the duel. All good!`);
        return;
      }
    } catch (e) {
      console.error("[DUEL] error:", e);
      twitchClient.say(channel, `Something broke while processing the duel command. Sorry!`);
      activeByUser.delete(sender);
    }
  });
}

// Bits verification (Helix: Get Extension Transactions)
async function verifyBitsTransaction(transactionId, userId) {
  try {
    if (!transactionId) {
      console.warn("[BITS] verify: missing transactionId");
      return false;
    }

    const params = new URLSearchParams({
      extension_id: EXT_CLIENT_ID,
      id: transactionId
    });

    const res = await fetch(`https://api.twitch.tv/helix/extensions/transactions?${params.toString()}`, {
      headers: {
        "Client-ID": EXT_CLIENT_ID,
        "Authorization": `Bearer ${EXT_APP_TOKEN}`
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

    const productType = tx.product?.type || tx.product_type;
    const okUser = String(tx.user_id) === String(userId);
    const okType = productType === "BITS_IN_EXTENSION";

    if (!okUser || !okType) {
      console.warn("[BITS] verify: validation failed", {
        okUser, okType, txUser: tx.user_id, wantUser: String(userId), productType
      });
    }

    return okUser && okType;
  } catch (e) {
    console.error("[BITS] verify error:", e);
    return false;
  }
}
// ===== Loot Command (SE Loyalty points) =====
const LOOT_COOLDOWN_MS = Number(process.env.LOOT_COOLDOWN_MS || 2 * 60 * 60 * 1000); // 2h
// You can override via env: LOOT_TABLE_JSON='{"common":{"weight":70,"amount":10000},...}'
const LOOT_TABLE = (() => {
  try {
    const j = JSON.parse(process.env.LOOT_TABLE_JSON);
    // minimal validation
    if (j && typeof j === "object") return j;
  } catch {}
  return {
    common:    { weight: 70, amount: 10_000 },
    uncommon:  { weight: 20, amount: 100_000 },
    rare:      { weight:  9, amount: 500_000 },
    legendary: { weight:  1, amount: 1_000_000 },
  };
})();

// Pick a rarity using weighted random
function pickLootFrom(table) {
  const entries = Object.entries(table).filter(([_, v]) => Number(v?.weight) > 0);
  const total = entries.reduce((s, [, v]) => s + Number(v.weight || 0), 0) || 1;
  let r = Math.random() * total;
  for (const [rarity, v] of entries) {
    r -= Number(v.weight || 0);
    if (r <= 0) {
      return { rarity, amount: Math.max(0, Number(v.amount || 0)) };
    }
  }
  const [rarity, v] = entries[0] || ["common", { amount: 0 }];
  return { rarity, amount: Math.max(0, Number(v.amount || 0)) };
}

// Simple per-user cooldown (in-memory)
const _lootLast = new Map(); // login -> last timestamp

twitchClient.on("message", async (channel, tags, msg, self) => {
  if (self) return;
  const text = (msg || "").trim();
  if (!/^!loot\b/i.test(text)) return;

  try {
    const user = parseLogin(tags.username);
    if (!user) return;

    const now = Date.now();
    const last = _lootLast.get(user) || 0;
    const since = now - last;

    if (since < LOOT_COOLDOWN_MS) {
      const remainingMs = LOOT_COOLDOWN_MS - since;
      const mins = Math.ceil(remainingMs / 60000);
      twitchClient.say(
        channel,
        `@${user} your loot cooldown is active — ${mins} minute${mins === 1 ? "" : "s"} remaining.`
      );
      return;
    }

    // Roll the loot
    const { rarity, amount } = pickLootFrom(LOOT_TABLE);

    // Award points using your existing adjustUserPoints helper
    const newTotal = await adjustUserPoints(user, amount);
    _lootLast.set(user, now);

    const pretty = (n) => Math.round(n).toLocaleString();
    const rarityLabel = rarity.toUpperCase();

    if (newTotal != null) {
      twitchClient.say(
        channel,
        `🎁 @${user} found a ${rarityLabel} chest! +${pretty(amount)} 🫘 ` +
        `(new total: ${pretty(newTotal)}). Next loot in 2 hours.`
      );
    } else {
      // In case points update failed (e.g., SE rate-limit), still message but clarify delay
      twitchClient.say(
        channel,
        `🎁 @${user} found a ${rarityLabel} chest! +${pretty(amount)} 🫘. ` +
        `Points update may be delayed. Next loot in 2 hours.`
      );
    }
  } catch (e) {
    console.error("[LOOT] error:", e);
  }
});
// GET leaderboard (for panel to fetch on load)
app.get("/v1/leaderboard", async (_req, res) => {
  try {
    const all = await Gelly.find().lean();
    const unique = _dedupeByLogin(all);
    const refreshed = [];
    for (const raw of unique) {
      const g = await Gelly.findById(raw._id);
      if (!g) continue;
      if (typeof g.applyDecay === "function") g.applyDecay();
      await updateCareScore(g, null);
      await g.save();
      refreshed.push(g);
    }
    const leaderboard = refreshed
      .map(g => ({
        displayName: g.displayName || g.loginName || "Unknown",
        loginName:   g.loginName,
        score:       Math.max(0, Math.round(g.careScore || 0)),
      }))
      .filter(e => e.loginName && e.loginName !== "guest" && e.loginName !== "unknown")
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    res.json({ success: true, entries: leaderboard });
  } catch (e) {
    console.error("[/v1/leaderboard] error:", e);
    res.status(500).json({ success: false });
  }
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
