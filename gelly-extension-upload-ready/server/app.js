const express = require('express');
const { sendLeaderboard, broadcastState } = require('./server');
const Gelly = require('./Gelly');
const cors = require('cors');

const allowedOrigins = [
  'https://*.ext-twitch.tv',
  'https://*.twitch.tv',
  'https://localhost:3000', // for local testing
];

app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));
const interactRoutes = require('./routes/interact');
app.use('/v1/interact', interactRoutes);


const app = express();
app.use(express.json());

// Persistent /v1/interact
app.post('/v1/interact', async (req, res) => {
  const { user, action } = req.body;
  if (!user) return res.json({ success: false, message: 'Missing user ID' });

  let gelly = await Gelly.findOne({ userId: user });
  if (!gelly) {
    gelly = new Gelly({ userId: user, points: 0 });
  }

  // Award points per action
  let pointsAwarded = 0;

  if (action.startsWith('color:')) {
    const color = action.split(':')[1];
    if (['blue', 'green', 'pink'].includes(color)) gelly.color = color;
    pointsAwarded = 1;
  } else {
    switch (action) {
      case 'feed':
        gelly.energy = Math.min(100, gelly.energy + 10);
        pointsAwarded = 5;
        break;
      case 'play':
        gelly.mood = Math.min(100, gelly.mood + 10);
        pointsAwarded = 5;
        break;
      case 'clean':
        gelly.cleanliness = Math.min(100, gelly.cleanliness + 10);
        pointsAwarded = 5;
        break;
      default:
        return res.json({ success: false, message: 'Unknown action' });
    }
  }

  // Add points
  gelly.points = (gelly.points || 0) + pointsAwarded;

  // Evolution logic
  if (gelly.stage === 'egg' && gelly.energy >= 100) gelly.stage = 'blob';
  if (gelly.stage === 'blob' && gelly.mood >= 100 && gelly.cleanliness >= 100) gelly.stage = 'gelly';

  gelly.lastUpdated = new Date();
  await gelly.save();

  // Notify all clients
  broadcastState(user, gelly);
  sendLeaderboard();

  res.json({ success: true });
});

module.exports = app;
