const express = require('express');
const cors = require('cors');
const app = express();
const http = require('http').createServer(app);
const WebSocket = require('ws');
const wss = new WebSocket.Server({ server: http });
const PORT = process.env.PORT || 3000;

let gellyStates = {};
let leaderboard = [];

app.use(cors());
app.use(express.json());

app.post('/interact', (req, res) => {
  const { user, action } = req.body;

  if (!gellyStates[user]) {
    gellyStates[user] = {
      energy: 100,
      mood: 50,
      cleanliness: 50,
      stage: 'egg',
      color: 'blue',
    };
  }

  const gelly = gellyStates[user];

  if (action.startsWith('color:')) {
    const color = action.split(':')[1];
    if (['blue', 'green', 'pink'].includes(color)) {
      gelly.color = color;
    }
    return res.json({ success: true });
  }

  switch (action) {
    case 'feed':
      if (gelly.energy < 100) gelly.energy += 10;
      break;
    case 'play':
      if (gelly.mood < 100) gelly.mood += 10;
      break;
    case 'clean':
      if (gelly.cleanliness < 100) gelly.cleanliness += 10;
      break;
    default:
      return res.json({ success: false, message: 'Unknown action' });
  }

  // Level up stages
  if (gelly.stage === 'egg' && gelly.energy >= 100) {
    gelly.stage = 'blob';
  } else if (gelly.stage === 'blob' && gelly.mood >= 100 && gelly.cleanliness >= 100) {
    gelly.stage = 'gelly';
  }

  updateLeaderboard(user, gelly.mood);
  broadcastState(user, gelly);
  res.json({ success: true });
});

function updateLeaderboard(user, mood) {
  const existing = leaderboard.find(e => e.user === user);
  if (existing) {
    existing.mood = mood;
  } else {
    leaderboard.push({ user, mood });
  }
  leaderboard.sort((a, b) => b.mood - a.mood);
}

function broadcastState(user, state) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'update', user, state }));
      client.send(JSON.stringify({ type: 'leaderboard', entries: leaderboard.slice(0, 5) }));
    }
  });
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const user = url.searchParams.get('user');
  if (user && gellyStates[user]) {
    ws.send(JSON.stringify({ type: 'update', state: gellyStates[user] }));
    ws.send(JSON.stringify({ type: 'leaderboard', entries: leaderboard.slice(0, 5) }));
  }
});

http.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
