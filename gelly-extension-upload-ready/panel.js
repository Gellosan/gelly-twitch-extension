window.Twitch.ext.onAuthorized(function (auth) {
  const twitchUserId = auth.userId;
  const SERVER_URL = "https://gelly-server.onrender.com";
  const GLOBAL_COOLDOWN = 60 * 1000;
  let lastActionTime = 0;

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

  function connectWebSocket() {
    if (!twitchUserId) return;
    const wsUrl = `${SERVER_URL.replace(/^http/, "ws")}/?user=${twitchUserId}`;
    const socket = new WebSocket(wsUrl);
    socket.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "update") updateUI(msg.state);
      else if (msg.type === "leaderboard") updateLeaderboard(msg.entries);
    });
  }

  function interact(action) {
    if (!twitchUserId) return showTempMessage("User not authenticated.", "red");
    const now = Date.now();
    if (now - lastActionTime < GLOBAL_COOLDOWN) {
      return showTempMessage("Please wait before interacting again.", "orange");
    }
    lastActionTime = now;

    let actionMessage = "";
    if (action === "play") actionMessage = "You play with your Gelly!";
    else if (action === "feed") actionMessage = "You feed your Gelly!";
    else if (action === "clean") actionMessage = "You clean your Gelly!";

    animateGelly(action);
    showTempMessage(actionMessage, "#0f0");

    fetch(`${SERVER_URL}/v1/interact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, user: twitchUserId }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!data.success) {
          showTempMessage(data.message || "Action failed", "red");
        }
      })
      .catch(() => {
        showTempMessage("Network error", "red");
      });
  }

  function updateLeaderboard(entries) {
    const list = document.getElementById("leaderboard-list");
    if (!list) return;
    const sorted = [...entries].sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.mood !== a.mood) return b.mood - a.mood;
      if (b.energy !== a.energy) return b.energy - a.energy;
      return b.cleanliness - a.cleanliness;
    });
    list.innerHTML = "";
    sorted.forEach((entry, index) => {
      const li = document.createElement("li");
      li.innerHTML = `<strong>#${index + 1}</strong> ${entry.displayName || entry.userId} 
        <em>(${entry.stage})</em> - ⭐ ${entry.points} | Mood: ${entry.mood} | Energy: ${entry.energy} | Cleanliness: ${entry.cleanliness}`;
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
    if (stage === "egg") gellyImage.src = "assets/egg.png";
    else if (stage === "blob") gellyImage.src = `assets/blob-${color}.png`;
    else if (stage === "gelly") gellyImage.src = `assets/gelly-${color}.png`;
  }

  document.getElementById("feedBtn")?.addEventListener("click", () => interact("feed"));
  document.getElementById("playBtn")?.addEventListener("click", () => interact("play"));
  document.getElementById("cleanBtn")?.addEventListener("click", () => interact("clean"));
  document.getElementById("helpBtn")?.addEventListener("click", () => {
    const box = document.getElementById("help-box");
    if (box) box.style.display = box.style.display === "none" ? "block" : "none";
  });

  connectWebSocket();
});

