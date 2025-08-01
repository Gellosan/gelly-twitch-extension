const express = require('express');
const cors = require('cors');
const { sendLeaderboard, broadcastState } = require('./server');
const Gelly = require('./models/Gelly'); // FIX: Correct path to Gelly model

const app = express(); // FIX: Declare app before using it

const allowedOrigins = [
  /\.ext-twitch\.tv$/, // regex instead of wildcard string
  /\.twitch\.tv$/,
  'https://localhost:3000' // for local testing
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.some(o => (o instanceof RegExp ? o.test(origin) : o === origin))) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json());

// Import interact routes if they exist
try {
  const interactRoutes = require('./routes/interact');
  app.use('/v1/interact', interactRoutes);
} catch (e) {
  console.warn('⚠️ No interact routes found, using inline handler instead.');
  // Fallback inline handler
  app.post('/v1/interact', async (req, res) => {
    const { user, action } = req.body;
    if (!user) return res.json({ success: false, message: 'Missing user ID' });

    let gelly = await Gelly.findOne({ userId: user });
    if (!gelly) {
      gelly = new Gelly({ userId: user, points: 0 });
    }

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

    gelly.points = (gelly.points || 0) + pointsAwarded;

    if (gelly.stage === 'egg' && gelly.energy >= 100) gelly.stage = 'blob';
    if (gelly.stage === 'blob' && gelly.mood >= 100 && gelly.cleanliness >= 100) gelly.stage = 'gelly';

    gelly.lastUpdated = new Date();
    await gelly.save();

    broadcastState(user, gelly);
    sendLeaderboard();

    res.json({ success: true });
  });
}

module.exports = app;
