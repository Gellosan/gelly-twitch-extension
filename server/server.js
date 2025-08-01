const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const Gelly = require('./models/Gelly');

const app = express();
app.use(express.json());

// Allow Twitch extension panel + your Render frontend
app.use(cors({
  origin: [
    /\.ext-twitch\.tv$/,                       // Twitch extension iframe
    'https://gelly-panel-kkp9.onrender.com',   // Your panel hosting on Render
    'https://localhost:8080',
    'http://localhost:8080'
  ],
  credentials: true
}));

// MongoDB connection
mongoose.connect(
  "mongodb+srv://Gellosan:SBI3Q64Te41O7050@gellocluster.gzlntn3.mongodb.net/?retryWrites=true&w=majority&appName=GelloCluster",
  {
    useNewUrlParser: true,
    useUnifiedTopology: true
  }
)
.then(() => console.log("✅ MongoDB Connected"))
.catch(err => console.error("❌ Mongo Error:", err));

/**
 * Interact endpoint
 * Expects: { user, action }
 */
app.post('/v1/interact', async (req, res) => {
  try {
    const { user, action } = req.body;
    if (!user) return res.status(400).json({ success: false, message: "Missing user" });

    let gelly = await Gelly.findOne({ userId: user });
    if (!gelly) {
      gelly = new Gelly({ userId: user });
    }

    // Apply action
    switch (action) {
      case 'feed':
        gelly.energy = Math.min(100, gelly.energy + 10);
        break;
      case 'play':
        gelly.mood = Math.min(100, gelly.mood + 10);
        break;
      case 'clean':
        gelly.cleanliness = Math.min(100, gelly.cleanliness + 10);
        break;
      default:
        if (action.startsWith('color:')) {
          gelly.color = action.split(':')[1];
        }
    }

    gelly.lastUpdated = new Date();
    await gelly.save();

    res.json({ success: true, message: "Action applied", state: gelly });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/**
 * Leaderboard endpoint
 */
app.get('/v1/leaderboard', async (req, res) => {
  try {
    const leaderboard = await Gelly.find()
      .sort({ mood: -1, energy: -1 })
      .limit(10)
      .select('userId displayName mood energy cleanliness color');

    res.json({ success: true, leaderboard });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
