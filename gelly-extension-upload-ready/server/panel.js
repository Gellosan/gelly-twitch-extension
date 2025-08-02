// ===== Gelly Extension Panel Script =====
let twitchUserId = null;
let loginName = null;
let jellybeanBalance = 0;
let cooldowns = {}; // Local cooldown tracker

// ===== UI Elements =====
const jellybeanBalanceEl = document.getElementById("jellybeanBalance");
const energyEl = document.getElementById("energy");
const moodEl = document.getElementById("mood");
const cleanlinessEl = document.getElementById("cleanliness");
const gellyImage = document.getElementById("gelly-image");
const leaderboardList = document.getElementById("leaderboard-list");
const messageEl = document.getElementById("message");

// ===== Utility =====
function showTempMessage(msg) {
  if (!messageEl) return;
  messageEl.textContent = msg;
  setTimeout(() => (messageEl.textContent = ""), 3000);
}

function animateGelly() {
  if (!gellyImage) return;
  gellyImage.classList.add("bounce");
  setTimeout(() => gellyImage.classList.remove("bounce"), 800);
}

function updateGellyImage(stage, color) {
  if (!gellyImage) return;
  if (stage === "egg") {
    gellyImage.src = `assets/egg.png`;
  } else if (stage === "blob") {
    gellyImage.src = `assets/blob_${color}.png`;
  } else {
    gellyImage.src = `assets/gelly_${color}.png`;
  }
}

// ===== Jellybean Balance =====
async function fetchJellybeanBalance() {
  if (!loginName) return;
  try {
    const res = await fetch(`https://gelly-server.onrender.com/v1/points/${loginName}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    jellybeanBalance = data.points || 0;
    if (jellybeanBalanceEl) {
      jellybeanBalanceEl.textContent = jellybeanBalance.toLocaleString();
    }
  } catch (err) {
    console.error("[ERROR] Failed to fetch jellybean balance:", err);
  }
}

// ===== State Updates =====
function updateUIFromState(state) {
  if (energyEl) energyEl.textContent = Math.floor(state.energy);
  if (moodEl) moodEl.textContent = Math.floor(state.mood);
  if (cleanlinessEl) cleanlinessEl.textContent = Math.floor(state.cleanliness);
  updateGellyImage(state.stage, state.color || "blue");
}

// ===== Leaderboard =====
function updateLeaderboard(entries) {
  if (!leaderboardList) return;
  leaderboardList.innerHTML = "";
  entries.forEach(entry => {
    const li = document.createElement("li");
    li.textContent = `${entry.displayName || entry.loginName}: ${entry.points}`;
    leaderboardList.appendChild(li);
  });
}

// ===== Cooldown Check =====
function isOnCooldown(action) {
  const now = Date.now();
  if (cooldowns[action] && cooldowns[action] > now) {
    const remaining = Math.ceil((cooldowns[action] - now) / 1000);
    showTempMessage(`Please wait ${remaining}s before ${action} again.`);
    return true;
  }
  return false;
}

function setCooldown(action, ms) {
  cooldowns[action] = Date.now() + ms;
}

// ===== Interact =====
async function interact(action) {
  if (!twitchUserId) return;

  // Match server.js cooldown rules
  const ACTION_COOLDOWNS = { feed: 300000, clean: 240000, play: 180000, color: 60000 };
  const cooldownKey = action.startsWith("color:") ? "color" : action;
  const cooldownMs = ACTION_COOLDOWNS[cooldownKey] || 60000;

  if (isOnCooldown(cooldownKey)) return;

  try {
    const res = await fetch("https://gelly-server.onrender.com/v1/interact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: twitchUserId, action })
    });
    const data = await res.json();

    if (!data.success) {
      showTempMessage(data.message || "Action failed");
    } else {
      animateGelly();

      // Set cooldown if success
      setCooldown(cooldownKey, cooldownMs);

      // Instantly update jellybean balance if provided
      if (typeof data.newBalance === "number") {
        jellybeanBalance = data.newBalance;
        if (jellybeanBalanceEl) {
          jellybeanBalanceEl.textContent = jellybeanBalance.toLocaleString();
        }
      } else {
        await fetchJellybeanBalance();
      }
    }
  } catch (err) {
    console.error("[ERROR] interact() failed:", err);
  }
}

// ===== Start Game =====
function startGame() {
  const startScreen = document.getElementById("landing-page");
  const gameScreen = document.getElementById("gelly-container");

  if (!startScreen || !gameScreen) {
    console.error("[ERROR] Missing start or game screen element in HTML");
    return;
  }

  startScreen.style.display = "none";
  gameScreen.style.display = "block";

  interact("startgame");
}

// ===== WebSocket =====
let ws;
function connectWebSocket() {
  if (!twitchUserId) return;
  ws = new WebSocket(`wss://gelly-server.onrender.com?user=${twitchUserId}`);
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "update") {
      updateUIFromState(msg.state);
    } else if (msg.type === "leaderboard") {
      updateLeaderboard(msg.entries);
    }
  };
}

// ===== Twitch Auth =====
Twitch.ext.onAuthorized(async function(auth) {
  twitchUserId = auth.userId;
  try {
    const res = await fetch(`https://gelly-server.onrender.com/v1/state/${twitchUserId}`);
    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        updateUIFromState(data.state);
        loginName = data.state.loginName;
        await fetchJellybeanBalance();
      }
    }
  } catch (err) {
    console.error("[ERROR] Fetching state failed:", err);
  }
  connectWebSocket();
});

// ===== Button Listeners =====
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("feedBtn")?.addEventListener("click", () => interact("feed"));
  document.getElementById("playBtn")?.addEventListener("click", () => interact("play"));
  document.getElementById("cleanBtn")?.addEventListener("click", () => interact("clean"));
  document.getElementById("startGameBtn")?.addEventListener("click", startGame);
});
