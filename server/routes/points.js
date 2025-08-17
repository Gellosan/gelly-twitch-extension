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

const lower = s => String(s || '').trim().toLowerCase();
const stripU = s => String(s || '').startsWith('U') ? String(s).slice(1) : String(s);

function tokenUserId(req) {
  try {
    const tok = (req.headers.authorization || '').split(' ')[1] || '';
    return jwt.decode(tok)?.user_id || null;
  } catch { return null; }
}

async function helixLoginById(id) {
  try {
    const res = await fetch(`https://api.twitch.tv/helix/users?id=${encodeURIComponent(id)}`, {
      headers: {
        'Client-ID': TWITCH_CLIENT_ID,
        'Authorization': `Bearer ${TWITCH_APP_ACCESS_TOKEN}`,
        'Accept': 'application/json',
      },
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    return data?.data?.[0]?.login ? lower(data.data[0].login) : null;
  } catch { return null; }
}

async function getPointsByLogin(login) {
  if (!login) return 0;
  try {
    const url = `${STREAM_ELEMENTS_API}/${STREAM_ELEMENTS_CHANNEL_ID}/${encodeURIComponent(login)}`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${STREAM_ELEMENTS_JWT}`, 'Accept': 'application/json' },
    });
    if (res.status === 404) return 0;
    if (!res.ok) return 0;
    const data = await res.json().catch(() => ({}));
    return typeof data?.points === 'number' ? data.points : 0;
  } catch { return 0; }
}

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

// GET /v1/points/by-user-id/:userId  (JWT → real id → login → SE points)
router.get('/by-user-id/:userId', async (req, res) => {
  try {
    const real = tokenUserId(req) || stripU(req.params.userId);
    if (!real) return res.json({ success: true, points: 0 });

    // Try DB (either real or opaque doc), then Helix
    let login = null;
    const doc = await (Gelly.findOne({ userId: real }).lean() ||
                       Gelly.findOne({ userId: `U${real}` }).lean());
    if (doc?.loginName) login = lower(doc.loginName);
    if (!login) login = await helixLoginById(real);

    if (!login) return res.json({ success: true, points: 0 });

    const points = await getPointsByLogin(login);
    res.json({ success: true, points });
  } catch (e) {
    console.error('[points/by-user-id] error:', e);
    res.status(500).json({ success: false, points: 0 });
  }
});

module.exports = router;
