window.Twitch.ext.onAuthorized(function (auth) {
  const twitchUserId = auth.userId;
  console.log("[DEBUG] onAuthorized fired. twitchUserId:", twitchUserId);

  if (!twitchUserId) {
    console.warn("[DEBUG] No Twitch user ID detected. Buttons will not send requests.");
  }

  const SERVER_URL = "https://gelly-server.onrender.com";
  let lastStage = null;

  const COOLDOWN_MS = 60000;
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

  function showTempMessage(msg, color = "#fff", duration = 2500) {
    const el = document.getElementById("message");
    if (!el) return;
    el.innerText = msg;
    el.style.color = color;
    el.style.opacity = "1";
    setTimeout(() => { el.style.opacity = "0"; }, duration);
  }

  function animateGelly(action) {
    const gellyImage = document.getElementById("gelly-image");
    if (!gellyImage) return;
    gellyImage.classList.add(`gelly-${action}-anim`);
    setTimeout(() => {
      gellyImage.classList.remove(`gelly-${action}-anim`);
    }, 800);
  }

  function showEvolutionMessage(newStage) {
    let stageName = "";
    if (newStage === "blob") stageName = "Blob!";
    else if (newStage === "gelly") stageName = "Adult Gelly!";

    if (stageName) {
      showTempMessage(`🎉 Your Gelly evolved into ${stageName}`, "#0ff", 4000);

      const gellyImage = document.getElementById("gelly-image");
      const background = document.getElementById("background");

      // Bounce animation
      gellyImage.classList.add("gelly-evolve-bounce");
      setTimeout(() => {
        gellyImage.classList.remove("gelly-evolve-bounce");
      }, 1200);

      // Sparkle animation
      background.classList.add("evolution-active");
      setTimeout(() => {
        background.classList.remove("evolution-active");
      }, 2500);
    }
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
    const cooldownKey = action.startsWith("color:") ? "color" : action;
    if (!canUseAction(cooldownKey)) return;

    animateGelly(action.includes("color:") ? "color" : action);
    showTempMessage(
      action === "play" ? "You play with your Gelly!" : `You ${action} your Gelly!`,
      "#0f0"
    );

    fetch(`${SERVER_URL}/v1/interact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, user: twitchUserId }),
    })
      .then(res => res.json())
      .then(data => {
        if (!data.success) showTempMessage(data.message || "Action failed", "red");
      })
      .catch(() => showTempMessage("Network error", "red"));
  }

  function updateLeaderboard(entries) {
    const list = document.getElementById("leaderboard-list");
    if (!list) return;
    const sorted = [...entries].sort((a, b) =>
      b.points - a.points || b.mood - a.mood || b.energy - a.energy || b.cleanliness - a.cleanliness
    );
    list.innerHTML = sorted.slice(0, 10).map((entry, i) =>
      `<li><strong>#${i + 1}</strong> ${entry.displayName || entry.userId}
      <span> - Points: ${entry.points} | Mood: ${entry.mood} | Energy: ${entry.energy} | Cleanliness: ${entry.cleanliness}</span></li>`
    ).join("");
  }

  function updateUI(state) {
    if (lastStage && state.stage !== lastStage) {
      showEvolutionMessage(state.stage);
    }
    lastStage = state.stage;

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

  function showHelp() {
    const box = document.getElementById("help-box");
    if (box) box.style.display = box.style.display === "none" ? "block" : "none";
  }

  document.getElementById("startGameBtn")?.addEventListener("click", () => {
    if (!twitchUserId) return showTempMessage("User not authenticated.", "red");
    fetch(`${SERVER_URL}/v1/state/${twitchUserId}`)
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          lastStage = data.state.stage;
          updateUI(data.state);
          document.getElementById("landing-page").style.display = "none";
          document.getElementById("gelly-container").style.display = "block";
          connectWebSocket();
        } else {
          showTempMessage("Failed to load Gelly.", "red");
        }
      });
  });

  document.getElementById("feedBtn")?.addEventListener("click", () => interact("feed"));
  document.getElementById("playBtn")?.addEventListener("click", () => interact("play"));
  document.getElementById("cleanBtn")?.addEventListener("click", () => interact("clean"));
  document.getElementById("gellyColor")?.addEventListener("change", (e) => {
    interact(`color:${e.target.value}`);
  });
  document.getElementById("helpBtn")?.addEventListener("click", showHelp);
});
