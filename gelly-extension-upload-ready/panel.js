// panel.js
window.Twitch.ext.onAuthorized(function (auth) {
  const twitchUserId = auth.userId;
  console.log("[DEBUG] onAuthorized fired. twitchUserId:", twitchUserId);

  if (!twitchUserId) {
    console.warn("[DEBUG] No Twitch user ID detected. Buttons will not send requests.");
  }

  const SERVER_URL = "https://gelly-server.onrender.com";

  // ========================
  // COOLDOWN SETTINGS
  // ========================
  const COOLDOWN_MS = 60000; // 60 seconds per action
  const lastActionTimes = { feed: 0, play: 0, clean: 0, color: 0 };

  function canUseAction(action) {
    const now = Date.now();
    if (now - lastActionTimes[action] < COOLDOWN_MS) {
      const remaining = Math.ceil((COOLDOWN_MS - (now - lastActionTimes[action])) / 1000);
      showTempMessage(`Please wait ${remaining}s before ${action} again.`, "yellow");
      return false;
    }
    lastActionTimes[action] = now;
    return true;
  }

  // ========================
  // FEEDBACK & ANIMATION
  // ========================
  function showTempMessage(msg, color = "#fff") {
    const el = document.getElementById("message");
    if (!el) return;
    el.innerText = msg;
    el.style.color = color;
    el.style.opacity = "1";
    setTimeout(() => { el.style.opacity = "0"; }, 2500);
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

    const cooldownKey = action.startsWith("color:") ? "color" : action;
    if (!canUseAction(cooldownKey)) return;

    console.log(`[DEBUG] Sending action to server: ${action}`);

    const actionMessage =
      action === "play" ? "You play with your Gelly!" : `You ${action} your Gelly!`;

    animateGelly(action.includes("color:") ? "color" : action);
    showTempMessage(actionMessage, "#0f0");

    fetch(`${SERVER_URL}/v1/interact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        user: twitchUserId // Backend resolves display name
      }),
    })
      .then(async (res) => {
        console.log("[DEBUG] Fetch response status:", res.status);
        const data = await res.json().catch(() => ({}));
        console.log("[DEBUG] Fetch response data:", data);
        if (!data.success) {
          showTempMessage(data.message || "Action failed", "red");
        }
      })
      .catch((err) => {
        console.error("[DEBUG] Network error during interact:", err);
        showTempMessage("Network error", "red");
      });
  }

  // ========================
  // UI UPDATES
  // ========================
  function updateLeaderboard(entries) {
    const list = document.getElementById("leaderboard-list");
    if (!list) return;

    const sorted = [...entries].sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.mood !== a.mood) return b.mood - a.mood;
      if (b.energy !== a.energy) return b.energy - a.energy;
      return b.cleanliness - a.cleanliness;
    });

    const topTen = sorted.slice(0, 10);
    list.innerHTML = "";

    topTen.forEach((entry, index) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <strong>#${index + 1}</strong> ${entry.displayName || entry.userId}
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

    gellyImage.style.maxWidth = "100%";
    gellyImage.style.height = "auto";
  }

  function showHelp() {
    console.log("[DEBUG] Toggling help box");
    const box = document.getElementById("help-box");
    if (box) box.style.display = box.style.display === "none" ? "block" : "none";
  }

  // ========================
  // LANDING PAGE → START GAME
  // ========================
  document.getElementById("startGameBtn")?.addEventListener("click", () => {
    if (!twitchUserId) {
      showTempMessage("User not authenticated.", "red");
      return;
    }

    fetch(`${SERVER_URL}/v1/state/${twitchUserId}`)
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          updateUI(data.state);
          document.getElementById("landing-page").style.display = "none";
          document.getElementById("gelly-container").style.display = "block";
          connectWebSocket(); // Connect after game starts
        } else {
          showTempMessage("Failed to load Gelly.", "red");
        }
      })
      .catch(err => {
        console.error("[DEBUG] Error fetching Gelly state:", err);
        showTempMessage("Error loading game", "red");
      });
  });

  // ========================
  // BUTTON LISTENERS
  // ========================
  document.getElementById("feedBtn")?.addEventListener("click", () => interact("feed"));
  document.getElementById("playBtn")?.addEventListener("click", () => interact("play"));
  document.getElementById("cleanBtn")?.addEventListener("click", () => interact("clean"));
  document.getElementById("gellyColor")?.addEventListener("change", (e) => {
    const color = e.target.value;
    interact(`color:${color}`);
  });
  document.getElementById("helpBtn")?.addEventListener("click", showHelp);
});
