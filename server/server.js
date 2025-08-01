const express = require('express');
const cors = require('cors');
const app = express();

// ---------- CORS FIX FOR TWITCH ----------
const allowedOrigins = [
  'https://localhost.twitch.tv', // Twitch local testing
  'https://*.ext-twitch.tv',     // Twitch production extension iframes
  'https://gelly-panel-kkp9.onrender.com' // Your panel hosting domain
];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, etc.)
    if (!origin) return callback(null, true);

    // Check if origin matches an allowed pattern
    if (allowedOrigins.some(o => {
      if (o.includes('*')) {
        // Convert wildcard to regex
        const regex = new RegExp('^' + o.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
        return regex.test(origin);
      }
      return o === origin;
    })) {
      return callback(null, true);
    }

    console.log('CORS blocked origin:', origin);
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// Handle OPTIONS preflight for all routes
app.options('*', cors());

// ---------- JSON Parsing ----------
app.use(express.json());

// ---------- Your Existing Routes ----------
const interactRoute = require('./routes/interact'); // Example
app.use('/v1/interact', interactRoute);

// ---------- Start Server ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
