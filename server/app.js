// app.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");

// --- Try to load helpers from your main server (safe fallbacks if not exported)
let sendLeaderboard = () => {};
let broadcastState = () => {};
try {
  // prefer explicit file if your server lives at server/server.js
  const srv = require("./server/server"); // or "./server" if you re-export there
  if (typeof srv.sendLeaderboard === "function") sendLeaderboard = srv.sendLeaderboard;
  if (typeof srv.broadcastState === "function") broadcastState = srv.broadcastState;
} catch (e) {
  console.warn("⚠️ Couldn’t import sendLeaderboard/broadcastState; using no-ops.", e?.message || e);
}

// ✅ FIX: Correct path to the merged model at server/models/Gelly.js
const Gelly = require("./models/Gelly");

const app = express(); // ✅ declare before use

// ---- CORS (allow Twitch + local dev)
const allowedOrigins = [
  /\.ext-twitch\.tv$/, // *.ext-twitch.tv
  /\.twitch\.tv$/,     // *.twitch.tv
  /^https?:\/\/localhost(?::\d+)?$/, // localhost with any port
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (
        !origin ||
        allowedOrigins.some((rule) =>
          rule instanceof RegExp ? rule.test(origin) : rule === origin
        )
      ) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

app.use(express.json());

// ---- Try to mount real interact routes if they exist
try {
  const interactRoutes = require("./routes/interact");
  app.use("/v1/interact", interactRoutes);
} catch {
  console.warn("⚠️ No interact routes found, using inline handler instead.");

  // Fallback inline handler (kept simple; relies on model methods where possible)
  app.post("/v1/interact", async (req, res) => {
    try {
      const { user, action } = req.body || {};
      if (!user) return res.json({ success: false, message: "Missing user ID" });
      if (!action || typeof action !== "string") {
        return res.json({ success: false, message: "Missing or invalid action" });
      }

      // Load/create user
      let gelly = await Gelly.findOne({ userId: user });
      if (!gelly) {
        gelly = new Gelly({ userId: user, points: 0 });
      }

      // Minimal points-award logic (your main server does SE deductions etc.)
      let pointsAwarded = 0;

      if (action.startsWith("color:")) {
        const color = (action.split(":")[1] || "").trim().toLowerCase();
        // accept any color asset you ship; or whitelist:
        // if (["blue","green","pink", ...].includes(color)) { ... }
        if (color) gelly.color = color;
        pointsAwarded = 1;
      } else if (action === "feed" || action === "play" || action === "clean") {
        // Use the model’s built-in logic (stat changes + growth thresholds)
        const result = gelly.updateStats(action);
        if (!result?.success) {
          return res.json({ success: false, message: result?.message || "Action failed" });
        }
        pointsAwarded = 5;
      } else {
        return res.json({ success: false, message: "Unknown action" });
      }

      gelly.points = (gelly.points || 0) + pointsAwarded;
      gelly.lastUpdated = new Date();
      await gelly.save();

      // Broadcast → panel + refresh leaderboard
      try { broadcastState(user, gelly); } catch (_) {}
      try { await Promise.resolve(sendLeaderboard()); } catch (_) {}

      // Shape matches panel expectations (state + optional newBalance)
      return res.json({
        success: true,
        state: gelly,
        // If you later wire StreamElements balance into this path, set newBalance here.
      });
    } catch (err) {
      console.error("[/v1/interact] error:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  });
}

// You typically export the app (so something else can .listen()), not start here.
// If you *do* want to run this file directly, uncomment the listen block.
module.exports = app;

/*
if (require.main === module) {
  const PORT = process.env.PORT || 8081;
  app.listen(PORT, () => {
    console.log(`✨ aux app listening on :${PORT}`);
  });
}
*/
