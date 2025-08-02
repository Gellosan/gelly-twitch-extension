// ===== Gelly Extension Panel Script =====
let twitchUserId = null;
let loginName = null;
let jellybeanBalance = 0;

// ===== UI Elements =====
const jellybeanBalanceEl = document.getElementById("jellybeanBalance");
const energyEl = document.getElementById("energy");
const moodEl = document.getElementById("mood");
const cleanlinessEl = document.getElementById("cleanliness");
const gellyImage = document.getElementById("gelly-image");
const leaderboardList = document.getElementById("leaderboard-list");
const messageEl = document.getElementById("message");
const gameScreenEl = document.getElementById("game-screen");
const startScreenEl = document.getElementById("start-screen");

// ===== Utility =====
function showTempMessage(msg) {
  messageEl.textContent = msg;
  setTimeout(() => (messageEl.textContent = ""), 3000);
}

function animateGelly() {
  gellyImage.classList.add("bounce");
  setTimeout(() => gellyImage.classList.remove("bounce"), 800);
}

function updateGellyImage(stage, color) {
  if (stage === "egg") {
    gellyImage.src = `assets/egg.png`; // Always the same egg sprite
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
    jellybeanBalanceEl.textContent = jellybeanBalance.toLocaleString();
  } catch (err) {
    console.error("[ERROR] Failed to fetch jellybean balance:", err);
  }
}

// ===== State Updates =====
function updateUIFromState(state) {
  energyEl.textContent = Math.floor(state.energy);
  moodEl.textContent = Math.floor(state.mood);
  cleanlinessEl.textContent = Math.floor(state.cleanliness);
  updateGellyImage(state.stage, state.color || "blue");
}

// ===== Leaderboard =====
function updateLeaderboard(entries) {
  leaderboardList.innerHTML = "";
  entries.forEach(entry => {
    const li = document.createElement("li");
    li.textContent = `${entry.displayName || entry.loginName}: ${entry.points}`;
    leaderboardList.appendChild(li);
  });
}

// ===== Interact =====
async function interact(action) {
  if (!twitchUserId) return;
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
      fetchJellybeanBalance();
    }
  } catch (err) {
    console.error("[ERROR] interact() failed:", err);
  }
}

// ===== Start Game =====
function startGame() {
  if (!gameScreenEl || !startScreenEl) {
    console.error("[ERROR] Missing start or game screen element in HTML");
    return;
  }
  gameScreenEl.style.display = "block";
  startScreenEl.style.display = "none";
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
document.getElementById("feedBtn")?.addEventListener("click", () => interact("feed"));
document.getElementById("playBtn")?.addEventListener("click", () => interact("play"));
document.getElementById("cleanBtn")?.addEventListener("click", () => interact("clean"));
document.getElementById("startGameBtn")?.addEventListener("click", startGame);
