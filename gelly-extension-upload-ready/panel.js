// ===== Gelly Extension Panel Script =====
let twitchUserId = null;
let twitchAuthToken = null; // Store Twitch JWT
let loginName = null;
let jellybeanBalance = 0;
let currentStage = "egg"; // Current Gelly stage

// ===== UI Elements =====
const jellybeanBalanceEl = document.getElementById("jellybeanBalance");
const energyEl = document.getElementById("energy");
const moodEl = document.getElementById("mood");
const cleanlinessEl = document.getElementById("cleanliness");
const gellyImage = document.getElementById("gelly-image");
const leaderboardList = document.getElementById("leaderboard-list");
const messageEl = document.getElementById("message");
const COLOR_CHANGE_COST = 10000;

// ===== Link Account Button =====
function showLinkButton() {
    const linkBtn = document.getElementById("linkAccountBtn");
    if (!linkBtn) return;
    linkBtn.style.display = "block";
    linkBtn.addEventListener("click", () => {
        Twitch.ext.actions.requestIdShare();
        localStorage.setItem("linkedOnce", "true"); // remember link
        linkBtn.style.display = "none";
        setTimeout(() => initGame(), 1000); // start after linking
    });
}

// ===== Utility =====
function showTempMessage(msg) {
    messageEl.textContent = msg;
    setTimeout(() => (messageEl.textContent = ""), 3000);
}

function animateGelly() {
    gellyImage.classList.add("bounce");
    setTimeout(() => gellyImage.classList.remove("bounce"), 800);
}

function triggerGellyAnimation(action) {
    if (!gellyImage) return;
    let animationClass = "";
    if (action === "feed") animationClass = "gelly-feed-anim";
    else if (action === "play") animationClass = "gelly-play-anim";
    else if (action === "clean") animationClass = "gelly-clean-anim";
    if (animationClass) {
        gellyImage.classList.add(animationClass);
        setTimeout(() => gellyImage.classList.remove(animationClass), 800);
    }
}

function triggerColorChangeEffect() {
    const gameContainer = document.getElementById("gelly-container");
    if (!gameContainer) return;
    gameContainer.classList.add("evolution-active");
    setTimeout(() => gameContainer.classList.remove("evolution-active"), 2500);
}

function updateGellyImage(stage, color) {
    if (stage === "egg") {
        gellyImage.src = `assets/egg.png`;
    } else if (stage === "blob") {
        gellyImage.src = `assets/blob-${color}.png`;
    } else {
        gellyImage.src = `assets/gelly-${color}.png`;
    }
}

function updateColorPickerButtons() {
    const colorSelect = document.getElementById("gellyColor");
    if (colorSelect) {
        colorSelect.disabled = jellybeanBalance < COLOR_CHANGE_COST;
    }
}

// ===== Cooldown Tracking =====
const cooldowns = {};
function isOnCooldown(action) {
    return cooldowns[action] && Date.now() < cooldowns[action];
}
function setCooldown(action, ms) {
    cooldowns[action] = Date.now() + ms;
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
        updateColorPickerButtons();
    } catch (err) {
        console.error("[ERROR] Failed to fetch jellybean balance:", err);
    }
}

// ===== State Updates =====
function updateUIFromState(state) {
    currentStage = state.stage;
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
        li.textContent = `${entry.displayName || entry.loginName}: ${entry.score} care score`;
        leaderboardList.appendChild(li);
    });
}

// ===== Interact =====
async function interact(action) {
    if (!twitchUserId || !twitchAuthToken) return;
    const ACTION_COOLDOWNS = { feed: 300000, clean: 240000, play: 180000, color: 60000 };
    const cooldownKey = action.startsWith("color:") ? "color" : action;
    const cooldownMs = ACTION_COOLDOWNS[cooldownKey] || 60000;
    const button =
        action === "feed" ? document.getElementById("feedBtn") :
        action === "play" ? document.getElementById("playBtn") :
        action === "clean" ? document.getElementById("cleanBtn") : null;
    if (isOnCooldown(cooldownKey)) return;
    try {
        const res = await fetch("https://gelly-server.onrender.com/v1/interact", {
            method: "POST",
            headers: { 
                "Authorization": `Bearer ${twitchAuthToken}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ user: twitchUserId, action })
        });
        const data = await res.json();
        if (!data.success) {
            showTempMessage(data.message || "Action failed");
            return;
        }
        if (action === "feed" || action === "play" || action === "clean") {
            triggerGellyAnimation(action);
        }
        if (action.startsWith("color:")) {
            triggerColorChangeEffect();
        }
        animateGelly();
        setCooldown(cooldownKey, cooldownMs);
        if (button) {
            const originalText = button.textContent;
            let remaining = Math.floor(cooldownMs / 1000);
            button.disabled = true;
            button.textContent = `${originalText} (${remaining}s)`;
            const interval = setInterval(() => {
                remaining -= 1;
                if (remaining > 0) {
                    button.textContent = `${originalText} (${remaining}s)`;
                } else {
                    clearInterval(interval);
                    button.disabled = false;
                    button.textContent = originalText;
                }
            }, 1000);
        }
        if (typeof data.newBalance === "number") {
            jellybeanBalance = data.newBalance;
            jellybeanBalanceEl.textContent = jellybeanBalance.toLocaleString();
            updateColorPickerButtons();
        } else {
            await fetchJellybeanBalance();
            updateColorPickerButtons();
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
}

// ===== WebSocket =====
let ws;
function connectWebSocket() {
    if (!twitchUserId) return;
    ws = new WebSocket(`wss://gelly-server.onrender.com?user=${twitchUserId}`);
    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "update") updateUIFromState(msg.state);
        else if (msg.type === "leaderboard") updateLeaderboard(msg.entries);
    };
}

// ===== Twitch Auth =====
Twitch.ext.onAuthorized(function(auth) {
    console.log("Authorized with ID:", auth.userId);
    twitchUserId = auth.userId;
    twitchAuthToken = auth.token;

    if (twitchUserId.startsWith("U") && localStorage.getItem("linkedOnce") !== "true") {
        console.log("⚠️ User is opaque — needs to link");
        showLinkButton();
        return;
    }

    // Already linked → start game
    initGame();
});

// ===== Init Game =====
async function initGame() {
    console.log("Starting game for user:", twitchUserId);
    try {
        const res = await fetch(`https://gelly-server.onrender.com/v1/state/${twitchUserId}`, {
            method: "GET",
            headers: {
                "Authorization": `Bearer ${twitchAuthToken}`,
                "Content-Type": "application/json"
            }
        });
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
    startGame();
}

// ===== Action Buttons =====
document.getElementById("feedBtn")?.addEventListener("click", () => interact("feed"));
document.getElementById("playBtn")?.addEventListener("click", () => interact("play"));
document.getElementById("cleanBtn")?.addEventListener("click", () => interact("clean"));
document.getElementById("startGameBtn")?.addEventListener("click", startGame);

document.addEventListener("DOMContentLoaded", () => {
    const startGameBtn = document.getElementById("startGameBtn");
    if (startGameBtn) {
        startGameBtn.addEventListener("click", startGame);
    }
});

// ===== Color Picker =====
document.querySelectorAll(".color-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        const selectedColor = btn.dataset.color;
        interact(`color:${selectedColor}`);
        triggerColorChangeEffect();
        updateGellyImage(currentStage, selectedColor);
    });
});

// ===== Help Button =====
document.getElementById("helpBtn")?.addEventListener("click", () => {
    const helpBox = document.getElementById("help-box");
    const helpBtn = document.getElementById("helpBtn");
    if (helpBox.style.display === "none" || helpBox.style.display === "") {
        helpBox.style.display = "block";
        helpBtn.textContent = "Close Help";
    } else {
        helpBox.style.display = "none";
        helpBtn.textContent = "Help";
    }
});
