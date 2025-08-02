let twitchUserId = null;
let username = null;
let jellybeanBalance = 0;
let socket = null;

async function fetchJellybeanBalance() {
  if (!username) return;
  try {
    const res = await fetch(`https://gelly-server.onrender.com/v1/points/${username}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    jellybeanBalance = data.points || 0;
    document.getElementById("jellybeanBalance").textContent = jellybeanBalance;
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
      fetchJellybeanBalance();
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

async function performAction(action) {
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

    jellybeanBalance = data.newBalance ?? jellybeanBalance;
    document.getElementById("jellybeanBalance").textContent = jellybeanBalance;

    fetchJellybeanBalance();
  } catch (err) {
    console.error("[ERROR] Failed to perform action:", err);
  }
}

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

if (window.Twitch && window.Twitch.ext) {
  window.Twitch.ext.onAuthorized((auth) => {
    twitchUserId = auth.userId;

    fetch(`https://gelly-server.onrender.com/v1/state/${twitchUserId}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.success && data.state) {
          username = data.state.loginName || "unknown";
          updateUI(data.state);
          fetchJellybeanBalance();
        }
      });

    connectWebSocket();
  });
}
