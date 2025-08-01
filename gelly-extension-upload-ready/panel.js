window.Twitch.ext.onAuthorized(function (auth) {
  const twitchUserId = auth.userId;
  console.log("[DEBUG] onAuthorized fired. twitchUserId:", twitchUserId);

  if (!twitchUserId) {
    console.warn("[DEBUG] No Twitch user ID detected. Buttons will not send requests.");
  }

  const SERVER_URL = "https://gelly-panel-kkp9.onrender.com";

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

  function interact(action) {
    if (!twitchUserId) {
      console.warn("[DEBUG] Attempted to interact without a Twitch user ID");
      return showMessage("User not authenticated.");
    }

    console.log(`[DEBUG] Sending action to server: ${action}`);
    fetch(`${SERVER_URL}/v1/interact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, user: twitchUserId }),
    })
      .then(async (res) => {
        console.log("[DEBUG] Fetch response status:", res.status);
        const data = await res.json().catch(() => ({}));
        console.log("[DEBUG] Fetch response data:", data);

        if (!data.success) {
          showMessage(data.message || "Action failed");
        } else {
          console.log("[DEBUG] Action succeeded:", action);
        }
      })
      .catch((err) => {
        console.error("[DEBUG] Network error during interact:", err);
        showMessage("Network error");
      });
  }

  function updateLeaderboard(entries) {
    const list = document.getElementById("leaderboard-list");
    if (!list) return;

    const sorted = [...entries].sort((a, b) => {
      if (b.mood !== a.mood) return b.mood - a.mood;
      if (b.energy !== a.energy) return b.energy - a.energy;
      return b.cleanliness - a.cleanliness;
    });

    const topTen = sorted.slice(0, 10);
    list.innerHTML = "";

    topTen.forEach((entry, index) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <strong>#${index + 1}</strong> ${entry.user}
        <span> - Mood: ${entry.mood} | Energy: ${entry.energy} | Cleanliness: ${entry.cleanliness}</span>
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

  function showMessage(msg) {
    console.log("[DEBUG] showMessage:", msg);
    const el = document.getElementById("message");
    el.innerText = msg;
    setTimeout(() => (el.innerText = ""), 3000);
  }

  function showHelp() {
    console.log("[DEBUG] Toggling help box");
    const box = document.getElementById("help-box");
    if (box) box.style.display = box.style.display === "none" ? "block" : "none";
  }

  // Attach button listeners
  document.getElementById("feedBtn")?.addEventListener("click", () => interact("feed"));
  document.getElementById("playBtn")?.addEventListener("click", () => interact("play"));
  document.getElementById("cleanBtn")?.addEventListener("click", () => interact("clean"));
  document.getElementById("helpBtn")?.addEventListener("click", showHelp);

  connectWebSocket();
});
