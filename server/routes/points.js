// server/routes/points.js
const express = require('express');
const router = express.Router();
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const Gelly = require('../models/Gelly');

// IMPORTANT: your streamer/broadcaster login (lowercase)
const SE_CHANNEL_LOGIN = String(process.env.SE_CHANNEL_LOGIN || '').toLowerCase();

async function seGetPoints(viewerLogin) {
  if (!SE_CHANNEL_LOGIN) throw new Error('SE_CHANNEL_LOGIN is not set');
  const channel = encodeURIComponent(SE_CHANNEL_LOGIN);
  const user = encodeURIComponent(String(viewerLogin || '').toLowerCase());
  const url = `https://api.streamelements.com/kappa/v2/points/${channel}/${user}`;

  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (res.status === 404) return 0; // no balance yet
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`[SE] ${res.status} ${text}`.slice(0, 200));
  }
  const json = await res.json().catch(() => ({}));
  return typeof json.points === 'number' ? json.points : 0;
}

// GET /v1/points/:login  -> lookup by login directly
router.get('/:login', async (req, res) => {
  try {
    const login = String(req.params.login || '').trim().toLowerCase();
    if (!login) return res.json({ success: false, points: 0, message: 'Missing login' });
    const points = await seGetPoints(login);
    return res.json({ success: true, points });
  } catch (err) {
    console.error('[POINTS] /:login error:', err.message || err);
    return res.status(502).json({ success: false, points: 0, message: 'StreamElements error' });
  }
});

// GET /v1/points/by-user-id/:userId -> resolve login in DB and then query SE
router.get('/by-user-id/:userId', async (req, res) => {
  try {
    const userId = String(req.params.userId || '').trim();
    if (!userId) return res.json({ success: false, points: 0, message: 'Missing userId' });
    const doc = await Gelly.findOne({ userId }, { loginName: 1 }).lean();
    const login = String(doc?.loginName || '').toLowerCase();
    if (!login) return res.json({ success: false, points: 0, message: 'Unknown login for userId' });
    const points = await seGetPoints(login);
    return res.json({ success: true, points, login });
  } catch (err) {
    console.error('[POINTS] /by-user-id error:', err.message || err);
    return res.status(502).json({ success: false, points: 0, message: 'StreamElements error' });
  }
});

module.exports = router;
