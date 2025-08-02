// panel.js
let twitchUserId = null;
let username = null;
let jellybeanBalance = 0;
let socket = null;
let cooldowns = {};

// Helper to fetch SE points from backend
async function fetchJellybeanBalance() {
  if (!username) return;
  try {
    const res = await fetch(`https://gelly-server.onrender.com/v1/points/${username}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    jellybeanBalance = data.points || 0;

    // Debug log
    console.log("[DEBUG] Current Jellybean Balance:", jellybeanBalance);

    // Update UI
    const balanceEl = document.getElementById("jellybeanBalance");
    if (balanceEl) balanceEl.textContent = jellybeanBalance;
  } catch (err) {
    console.error("[ERROR] Failed to fetch jellybean balance:", err);
  }
}

function connectWebSocket() {
  if (!twitchUserId) return;
  socket = new WebSocket(`wss://gelly-server.onrender.com?user=${twitchUserId}`);
  
  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "update") {
      updateUI(msg.state);
      fetchJellybeanBalance(); // Refresh balance on server push
    }
    if (msg.type === "leaderboard") {
      updateLeaderboard(msg.entries);
    }
  };
}

function updateUI(state) {
  document.getElementById("energy").textContent = state.energy.toFixed(0);
  document.getElementById("mood").textContent = state.mood.toFixed(0);
  document.getElementById("cleanliness").textContent = state.cleanliness.toFixed(0);
  document.getElementById("gelly-image").src = `assets/${state.stage}_${state.color}.png`;
}

function updateLeaderboard(entries) {
  const lbList = document.getElementById("leaderboard-list");
  lbList.innerHTML = "";
  entries.forEach((entry) => {
    const li = document.createElement("li");
    li.textContent = `${entry.displayName || "Unknown"} - ${entry.points || 0}`;
    lbList.appendChild(li);
  });
}

function setCooldown(action, ms) {
  cooldowns[action] = Date.now() + ms;
}

function isCooldownActive(action) {
  return cooldowns[action] && Date.now() < cooldowns[action];
}

async function performAction(action) {
  if (isCooldownActive(action)) {
    alert(`Please wait before ${action} again.`);
    return;
  }

  try {
    const res = await fetch("https://gelly-server.onrender.com/v1/interact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: twitchUserId, action })
    });

    const data = await res.json();
    if (!data.success) {
      alert(data.message);
      return;
    }

    // Action succeeded → update cooldowns
    if (action === "feed") setCooldown(action, 5 * 60 * 1000);
    if (action === "clean") setCooldown(action, 4 * 60 * 1000);
    if (action === "play") setCooldown(action, 3 * 60 * 1000);

    // Refresh jellybean balance instantly after action
    await fetchJellybeanBalance();
  } catch (err) {
    console.error("[ERROR] Failed to perform action:", err);
  }
}

// Event bindings
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("startGameBtn").addEventListener("click", () => {
    document.getElementById("landing-page").style.display = "none";
    document.getElementById("gelly-container").style.display = "block";
    fetchJellybeanBalance();
  });

  document.getElementById("feedBtn").addEventListener("click", () => performAction("feed"));
  document.getElementById("playBtn").addEventListener("click", () => performAction("play"));
  document.getElementById("cleanBtn").addEventListener("click", () => performAction("clean"));
  document.getElementById("gellyColor").addEventListener("change", (e) => {
    performAction(`color:${e.target.value}`);
  });
});

// Twitch authorization
if (window.Twitch && window.Twitch.ext) {
  window.Twitch.ext.onAuthorized((auth) => {
    twitchUserId = auth.userId;
    console.log("[DEBUG] onAuthorized fired. twitchUserId:", twitchUserId);

    fetch(`https://gelly-server.onrender.com/v1/state/${twitchUserId}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.success && data.state) {
          username = data.state.loginName || "unknown";
          updateUI(data.state);
          fetchJellybeanBalance(); // Fetch initial balance
        }
      })
      .catch((err) => console.error("[ERROR] Failed to fetch initial state:", err));

    connectWebSocket();
  });
}
