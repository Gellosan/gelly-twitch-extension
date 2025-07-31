
const express = require('express');
const WebSocket = require('ws');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const SE_API_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJjaXRhZGVsIiwiZXhwIjoxNzU2NTQ1MDg4LCJqdGkiOiI4ZGMzNDMxZS0xZWI4LTQ3ODQtYTU1Ny0zODBhMWYyNjJlM2YiLCJjaGFubmVsIjoiNjdjNTcyNDA5MWZlMDAwOTkwMzEyNjNmIiwicm9sZSI6Im93bmVyIiwiYXV0aFRva2VuIjoiSkNVNVBZakRETzB6WFlmZ1l5T3EyTG04M3FUbjkya3B0SnJkWVg3dTZvUlRxUHhDIiwidXNlciI6IjY3YzU3MjQwOTFmZTAwMDk5MDMxMjYzZSIsInVzZXJfaWQiOiJlM2RjYjFkMy00NDNiLTQ1ODgtODQ4Ny0xMmRiYjMxZGRjOGUiLCJ1c2VyX3JvbGUiOiJjcmVhdG9yIiwicHJvdmlkZXIiOiJ0d2l0Y2giLCJwcm92aWRlcl9pZCI6IjUzMjQ0NzI1NyIsImNoYW5uZWxfaWQiOiI5YTljZGIzYy1hNDlmLTQ1OGUtODA2Zi03YjE5NGFhZTgzNzEiLCJjcmVhdG9yX2lkIjoiNTkyNTdlZjgtZDNiOS00YzNiLWFhMDMtMzMzOWU1ZDk0YTIwIn0.tYrIHGEhYfT1fxVPQayV7uRUqh52sYzJzPhhcTwB-lA";
const CHANNEL_ID = "9a9cdb3c-a49f-458e-806f-7b194aae8371";

const server = app.listen(PORT, () => console.log('Duck server running on port', PORT));
const wss = new WebSocket.Server({ server });

const users = {};
const feedLimits = {};

function getUser(user) {
  if (!users[user]) {
    users[user] = {
      energy: 100,
      mood: 50,
      cleanliness: 50,
      stage: 'egg',
      color: 'blue',
      lastActive: Date.now()
    };
  }
  return users[user];
}

function broadcastLeaderboard() {
  const entries = Object.entries(users).map(([user, data]) => {
    return { user, mood: data.mood };
  }).sort((a, b) => b.mood - a.mood).slice(0, 10);

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'leaderboard', entries }));
    }
  });
}

function decayStats() {
  const now = Date.now();
  Object.values(users).forEach(u => {
    if (now - u.lastActive >= 86400000) {
      u.energy = Math.max(0, u.energy - 10);
      u.mood = Math.max(0, u.mood - 5);
      u.cleanliness = Math.max(0, u.cleanliness - 5);
      u.lastActive = now;
    }
  });
  broadcastAll();
}

function broadcastAll() {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.userId) {
      client.send(JSON.stringify({ type: 'update', state: users[client.userId] }));
    }
  });
}

setInterval(decayStats, 60 * 60 * 1000);

app.post('/interact', async (req, res) => {
  const { action, user } = req.body;
  const data = getUser(user);
  data.lastActive = Date.now();

  if (action === 'feed') {
    const now = Date.now();
    if (!feedLimits[user]) feedLimits[user] = [];
    feedLimits[user] = feedLimits[user].filter(t => now - t < 3600000);
    if (feedLimits[user].length >= 3)
      return res.json({ success: false, message: 'Feed limit reached (3x/hr).' });

    const balance = await fetch(`https://api.streamelements.com/kappa/v2/points/${CHANNEL_ID}/${user}`, {
      headers: { 'Authorization': `Bearer ${SE_API_TOKEN}` }
    }).then(r => r.json());

    if (!balance.points || balance.points < 1000)
      return res.json({ success: false, message: 'Not enough loyalty points.' });

    await fetch(`https://api.streamelements.com/kappa/v2/points/${CHANNEL_ID}/${user}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${SE_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ amount: -1000 })
    });

    data.energy = Math.min(100, data.energy + 20);
    feedLimits[user].push(now);
  }
  else if (action === 'play') {
    data.mood = Math.min(9999, data.mood + 10);
  }
  else if (action === 'clean') {
    data.cleanliness = Math.min(100, data.cleanliness + 15);
  }
  else if (action.startsWith('color:')) {
    data.color = action.split(':')[1];
  }

  if (data.energy > 50 && data.mood > 50 && data.cleanliness > 50)
    data.stage = 'gelly';
  else if (data.energy > 30)
    data.stage = 'blob';
  else
    data.stage = 'egg';

  broadcastAll();
  res.json({ success: true });
});

wss.on('connection', (ws, req) => {
  const userId = new URLSearchParams(req.url.slice(2)).get('user');
  ws.userId = userId;
  const data = getUser(userId);
  ws.send(JSON.stringify({ type: 'update', state: data }));
  broadcastLeaderboard();
});
