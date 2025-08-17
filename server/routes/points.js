// routes/points.js
const router = require('express').Router();
const jwt = require('jsonwebtoken');
const Gelly = require('../Gelly.js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const STREAM_ELEMENTS_API = 'https://api.streamelements.com/kappa/v2/points';
const STREAM_ELEMENTS_JWT = process.env.STREAMELEMENTS_JWT;
const STREAM_ELEMENTS_CHANNEL_ID = process.env.STREAMELEMENTS_CHANNEL_ID;
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_APP_ACCESS_TOKEN = process.env.TWITCH_APP_ACCESS_TOKEN;

const lower  = s => String(s || '').trim().toLowerCase();
const stripU = s => String(s || '').startsWith('U') ? String(s).slice(1) : String(s);

function tokenUserId(req) {
  try {
    const tok = (req.headers.authorization || '').split(' ')[1] || '';
    return jwt.decode(tok)?.user_id || null;
  } catch { return null; }
}

async function helixLoginById(id) {
  if (!id) return null;
  try {
    const res = await fetch(`https://api.twitch.tv/helix/users?id=${encodeURIComponent(id)}`, {
      headers: {
        'Client-ID': TWITCH_CLIENT_ID,
        'Authorization': `Bearer ${TWITCH_APP_ACCESS_TOKEN}`,
        'Accept': 'application/json',
      },
    });
    if (res.status === 401 || res.status === 403) {
      console.warn('[helixLoginById] Helix auth error', res.status);
      return null;
    }
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    return data?.data?.[0]?.login ? lower(data.data[0].login) : null;
  } catch (e) {
    console.warn('[helixLoginById] error', e?.message || e);
    return null;
  }
}

// ---- tiny 5s points cache to smooth UI + spare SE rate limit ----
const _pointsCache = new Map(); // login -> { points, ts }
const POINTS_CACHE_MS = 5000;

async function getPointsByLogin(login) {
  login = lower(login);
  if (!login || login === 'guest' || login === 'unknown') return 0;

  const now = Date.now();
  const hit = _pointsCache.get(login);
  if (hit && (now - hit.ts) < POINTS_CACHE_MS) return hit.points;

  try {
    const url = `${STREAM_ELEMENTS_API}/${STREAM_ELEMENTS_CHANNEL_ID}/${encodeURIComponent(login)}`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${STREAM_ELEMENTS_JWT}`, 'Accept': 'application/json' },
    });
    if (res.status === 404) {
      _pointsCache.set(login, { points: 0, ts: now });
      return 0;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn('[SE] get points HTTP', res.status, text);
      return hit ? hit.points : 0; // fall back to last known if any
    }
    const data = await res.json().catch(() => ({}));
    const pts = typeof data?.points === 'number' ? data.points : 0;
    _pointsCache.set(login, { points: pts, ts: now });
    return pts;
  } catch (e) {
    console.warn('[SE] get points error:', e?.message || e);
    return hit ? hit.points : 0;
  }
}

// ---------- ROUTES ----------

// GET /v1/points/by-user-id/:userId  (JWT → real id → login → SE points)
router.get('/by-user-id/:userId', async (req, res) => {
  try {
    const real = tokenUserId(req) || stripU(req.params.userId);
    if (!real) return res.json({ success: true, points: 0 });

    // Try DB (real then opaque), then Helix
    let doc = await Gelly.findOne({ userId: real }).lean();
    if (!doc) doc = await Gelly.findOne({ userId: `U${real}` }).lean();

    let login = doc?.loginName ? lower(doc.loginName) : null;
    if (!login) login = await helixLoginById(real);

    if (!login) return res.json({ success: true, points: 0 });

    const points = await getPointsByLogin(login);
    res.json({ success: true, points });
  } catch (e) {
    console.error('[points/by-user-id] error:', e);
    res.status(500).json({ success: false, points: 0 });
  }
});

// GET /v1/points/:username  (login-based)
router.get('/:username', async (req, res) => {
  try {
    const login = lower(req.params.username);
    const points = await getPointsByLogin(login);
    res.json({ success: true, points });
  } catch {
    res.status(500).json({ success: false, points: 0 });
  }
});

module.exports = router;
