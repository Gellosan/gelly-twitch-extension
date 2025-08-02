window.Twitch.ext.onAuthorized(function (auth) {
  const twitchUserId = auth.userId;
  console.log("[DEBUG] onAuthorized fired. twitchUserId:", twitchUserId);

  if (!twitchUserId) {
    console.warn("[DEBUG] No Twitch user ID detected. Buttons will not send requests.");
  }

  const SERVER_URL = "https://gelly-server.onrender.com";

  // Track last action times locally (per action)
  const lastActionTimes = {
    feed: 0,
    play: 0,
    clean: 0
  };
  const COOLDOWN_MS = 60000; // 60 seconds

  // ========================
  // FEEDBACK & ANIMATION
  // ========================
  function showTempMessage(msg, color = "#fff") {
    const el = document.getElementById("message");
    if (!el) return;
    el.innerText = msg;
    el.style.color = color;
    el.style.opacity = "1";

    setTimeout(() => {
      el.style.opacity = "0";
    }, 2000);
  }

  function animateGelly(action) {
    const gellyImage = document.getElementById("gelly-image");
    if (!gellyImage) return;

    gellyImage.classList.add(`gelly-${action}-anim`);
    setTimeout(() => {
      gellyImage.classList.remove(`gelly-${action}-anim`);
    }, 800);
  }

  // ========================
  // WEBSOCKET
  // ========================
  function connectWebSocket() {
    if (!twitchUserId) {
      console.warn("[DEBUG] No Twitch user ID, skipping WebSocket connection.");
      return;
    }
    const wsUrl = `${SERVER_URL.replace(/^http/, "ws")}/?user=${twitchUserId}`;
    console.log("[DEBUG] Connecting WebSocket:", wsUrl);

    const socket = new WebSocket(wsUrl);

    socket.addEventListener("open", () => console.log("[DEBUG] WebSocket connected"));
    socket.addEventListener("error", (err) => console.error("[DEBUG] WebSocket error", err));

    socket.addEventListener("message", (event) => {
      console.log("[DEBUG] WebSocket message received:", event.data);
      const msg = JSON.parse(event.data);
      if (msg.type === "update") updateUI(msg.state);
      else if (msg.type === "leaderboard") updateLeaderboard(msg.entries);
    });
  }

  // ========================
  // ACTION HANDLER
  // ========================
  function interact(action) {
    if (!twitchUserId) {
      console.warn("[DEBUG] Attempted to interact without a Twitch user ID");
      return showTempMessage("User not authenticated.", "red");
    }

    // Cooldown check (per action)
    const now = Date.now();
    if (now - lastActionTimes[action] < COOLDOWN_MS) {
      const remaining = Math.ceil((COOLDOWN_MS - (now - lastActionTimes[action])) / 1000);
      return showTempMessage(`Please wait ${remaining}s before doing that again.`, "yellow");
    }

    // Save time locally
    lastActionTimes[action] = now;

    console.log(`[DEBUG] Sending action to server: ${action}`);

    // Instant animation + feedback BEFORE network finishes
    animateGelly(action);
    if (action === "play") {
      showTempMessage("You play with your Gelly!", "#0f0");
    } else if (action === "feed") {
      showTempMessage("You feed your Gelly!", "#0f0");
    } else if (action === "clean") {
      showTempMessage("You clean your Gelly!", "#0f0");
    }

    fetch(`${SERVER_URL}/v1/interact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, user: twitchUserId }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!data.success) {
          // Reset cooldown if server rejects
          lastActionTimes[action] = 0;
          showTempMessage(data.message || "Action failed", "red");
        }
      })
      .catch((err) => {
        console.error("[DEBUG] Network error during interact:", err);
        lastActionTimes[action] = 0;
        showTempMessage("Network error", "red");
      });
  }

  // ========================
  // UI UPDATES
  // ========================
  function updateLeaderboard(entries) {
    const list = document.getElementById("leaderboard-list");
    if (!list) return;

    list.innerHTML = "";
    entries.forEach((entry) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <strong>#${entry.rank}</strong> ${entry.user}
        <span> - Points: ${entry.points} | Mood: ${entry.mood} | Energy: ${entry.energy} | Cleanliness: ${entry.cleanliness}</span>
      `;
      list.appendChild(li);
    });
  }

  function updateUI(state) {
    console.log("[DEBUG] Updating UI with state:", state);
    document.getElementById("energy").innerText = state.energy;
    document.getElementById("mood").innerText = state.mood;
    document.getElementById("cleanliness").innerText = state.cleanliness;

    const gellyImage = document.getElementById("gelly-image");
    const stage = state.stage || "egg";
    const color = state.color || "blue";

    if (stage === "egg") {
      gellyImage.src = "assets/egg.png";
    } else if (stage === "blob") {
      gellyImage.src = `assets/blob-${color}.png`;
    } else if (stage === "gelly") {
      gellyImage.src = `assets/gelly-${color}.png`;
    }
  }

  function showHelp() {
    console.log("[DEBUG] Toggling help box");
    const box = document.getElementById("help-box");
    if (box) box.style.display = box.style.display === "none" ? "block" : "none";
  }

  // ========================
  // BUTTON LISTENERS
  // ========================
  document.getElementById("feedBtn")?.addEventListener("click", () => interact("feed"));
  document.getElementById("playBtn")?.addEventListener("click", () => interact("play"));
  document.getElementById("cleanBtn")?.addEventListener("click", () => interact("clean"));
  document.getElementById("helpBtn")?.addEventListener("click", showHelp);

  connectWebSocket();
});
