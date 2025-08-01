const SERVER_URL = "https://gelly-panel-kkp9.onrender.com";

window.Twitch.ext.onAuthorized((auth) => {
  const twitchUserId = auth.userId;
  console.log("[DEBUG] onAuthorized fired. twitchUserId:", twitchUserId);

  function connectWebSocket() {
    if (!twitchUserId) return;
    const wsProtocol = SERVER_URL.startsWith("https") ? "wss" : "ws";
    const wsUrl = `${SERVER_URL.replace(/^https?/, wsProtocol)}/?user=${encodeURIComponent(twitchUserId)}`;
    console.log("[DEBUG] Connecting WebSocket:", wsUrl);

    const socket = new WebSocket(wsUrl);

    socket.addEventListener("open", () => console.log("[DEBUG] WebSocket connected"));
    socket.addEventListener("error", (err) => console.error("[DEBUG] WebSocket error", err));

    socket.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "update") updateUI(msg.state);
      else if (msg.type === "leaderboard") updateLeaderboard(msg.entries);
    });
  }

  function interact(action) {
    if (!twitchUserId) return showMessage("User not authenticated.");
    console.log(`[DEBUG] Sending action to server: ${action}`);

    fetch(`${SERVER_URL}/v1/interact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, user: twitchUserId }),
    })
      .then(res => res.json())
      .then(data => {
        if (!data.success) showMessage(data.message || "Action failed");
      })
      .catch(err => {
        console.error("[DEBUG] Network error:", err);
        showMessage("Network error");
      });
  }

  function updateLeaderboard(entries) {
    const list = document.getElementById("leaderboard-list");
    if (!list) return;
    list.innerHTML = "";
    entries.forEach((entry, index) => {
      const li = document.createElement("li");
      li.innerHTML = `<strong>#${index + 1}</strong> ${entry.user} - Mood: ${entry.mood} | Energy: ${entry.energy} | Cleanliness: ${entry.cleanliness}`;
      list.appendChild(li);
    });
  }

  function updateUI(state) {
    document.getElementById("energy").innerText = state.energy;
    document.getElementById("mood").innerText = state.mood;
    document.getElementById("cleanliness").innerText = state.cleanliness;
    const gellyImage = document.getElementById("gelly-image");
    const stage = state.stage || "egg";
    const color = state.color || "blue";
    gellyImage.src = stage === "egg" ? "assets/egg.png" : `assets/${stage}-${color}.png`;
  }

  function showMessage(msg) {
    const el = document.getElementById("message");
    el.innerText = msg;
    setTimeout(() => (el.innerText = ""), 3000);
  }

  function showHelp() {
    const box = document.getElementById("help-box");
    if (box) box.style.display = box.style.display === "none" ? "block" : "none";
  }

  document.getElementById("feedBtn")?.addEventListener("click", () => interact("feed"));
  document.getElementById("playBtn")?.addEventListener("click", () => interact("play"));
  document.getElementById("cleanBtn")?.addEventListener("click", () => interact("clean"));
  document.getElementById("helpBtn")?.addEventListener("click", showHelp);

  connectWebSocket();
});

