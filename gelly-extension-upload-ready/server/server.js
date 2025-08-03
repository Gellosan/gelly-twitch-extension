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

    // ===== FEED =====
    if (action === "feed") {
      if (userPoints < 1000) {
        return res.json({ success: false, message: "Not enough Jellybeans to feed." });
      }
      const beforePoints = userPoints;
      await deductUserPoints(usernameForPoints, 1000);
      await new Promise(r => setTimeout(r, 2000));
      userPoints = await getUserPoints(usernameForPoints);
      console.log(`[DEBUG] Feed points change: ${beforePoints} -> ${userPoints}`);
      gelly.energy = Math.min(500, gelly.energy + 20);
      actionSucceeded = true;

    // ===== COLOR CHANGE =====
    } else if (action.startsWith("color:")) {
      if (userPoints < 10000) {
        return res.json({ success: false, message: "Not enough Jellybeans to change color." });
      }
      const beforePoints = userPoints;
      await deductUserPoints(usernameForPoints, 10000);
      await new Promise(r => setTimeout(r, 2000));
      userPoints = await getUserPoints(usernameForPoints);
      console.log(`[DEBUG] Color change points: ${beforePoints} -> ${userPoints}`);
      gelly.color = action.split(":")[1] || "blue";
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

    // ===== UNKNOWN =====
    } else {
      return res.json({ success: false, message: "Unknown action" });
    }

    // ===== SAVE & BROADCAST =====
    if (actionSucceeded) {
      gelly.lastActionTimes[cooldownKey] = now;
      await gelly.save();
      const updatedBalance = await getUserPoints(usernameForPoints);
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
