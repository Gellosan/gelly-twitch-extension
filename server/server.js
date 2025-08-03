app.post("/v1/interact", async (req, res) => {
  try {
    const { user, action } = req.body;
    if (!user) return res.json({ success: false, message: "Missing user ID" });

    let gelly = await Gelly.findOne({ userId: user });
    if (!gelly) gelly = new Gelly({ userId: user, points: 0 });

    if (typeof gelly.applyDecay === "function") gelly.applyDecay();

    if (!gelly.displayName || !gelly.loginName) {
      const twitchData = await fetchTwitchUserData(user);
      if (twitchData) {
        gelly.displayName = twitchData.displayName;
        gelly.loginName = twitchData.loginName;
      } else {
        gelly.displayName = "Unknown";
        gelly.loginName = "unknown";
      }
    }

    const usernameForPoints = gelly.loginName;
    console.log(`[DEBUG] Interact: ${action} for ${usernameForPoints}`);
    let userPoints = await getUserPoints(usernameForPoints);
    console.log(`[DEBUG] SE returned points: ${userPoints}`);

    const ACTION_COOLDOWNS = { feed: 300000, clean: 240000, play: 180000, color: 60000 };
    const cooldownKey = action.startsWith("color:") ? "color" : action;
    const cooldown = ACTION_COOLDOWNS[cooldownKey] || 60000;
    const now = new Date();

    if (gelly.lastActionTimes[cooldownKey] && now - gelly.lastActionTimes[cooldownKey] < cooldown) {
      const remaining = Math.ceil((cooldown - (now - gelly.lastActionTimes[cooldownKey])) / 1000);
      return res.json({ success: false, message: `Please wait ${remaining}s before ${cooldownKey} again.` });
    }

    let actionSucceeded = false;
    let deductionAmount = 0;

    // ===== FEED =====
    if (action === "feed") {
      deductionAmount = 1000;
      if (userPoints < deductionAmount) {
        return res.json({ success: false, message: "Not enough Jellybeans to feed." });
      }
      await deductUserPoints(usernameForPoints, deductionAmount);
      gelly.energy = Math.min(500, gelly.energy + 20);
      actionSucceeded = true;

    // ===== COLOR CHANGE =====
    } else if (action.startsWith("color:")) {
      deductionAmount = 10000;
      if (userPoints < deductionAmount) {
        return res.json({ success: false, message: "Not enough Jellybeans to change color." });
      }
      await deductUserPoints(usernameForPoints, deductionAmount);
      gelly.color = action.split(":")[1] || "blue"; // always save color
      actionSucceeded = true;

    // ===== PLAY =====
    } else if (action === "play") {
      gelly.mood = Math.min(500, gelly.mood + 20);
      actionSucceeded = true;

    // ===== CLEAN =====
    } else if (action === "clean") {
      gelly.cleanliness = Math.min(500, gelly.cleanliness + 20);
      actionSucceeded = true;

    // ===== START GAME =====
    } else if (action === "startgame") {
      gelly.points = 0;
      gelly.energy = 100;
      gelly.mood = 100;
      gelly.cleanliness = 100;
      gelly.lastUpdated = new Date();
      actionSucceeded = true;

    } else {
      return res.json({ success: false, message: "Unknown action" });
    }

    if (actionSucceeded) {
      gelly.lastActionTimes[cooldownKey] = now;
      await gelly.save();

      // ✅ Instantly update balance without waiting for SE delay
      const updatedBalance = Math.max(0, userPoints - deductionAmount);

      // Send updates to panel + leaderboard
      broadcastState(user, gelly);
      sendLeaderboard();

      return res.json({ success: true, newBalance: updatedBalance });
    }

    res.json({ success: false, message: "Action failed" });

  } catch (err) {
    console.error("[ERROR] /v1/interact:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});
