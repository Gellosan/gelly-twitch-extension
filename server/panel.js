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
const COLOR_CHANGE_COST = 50000;

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

// ===== Updated: Gelly Image with Accessories =====
function updateGellyImage(stage, color, equippedItems = []) {
    const container = document.getElementById("background");
    container.innerHTML = ""; // Clear old content

    // Base pet image
    const baseImg = document.createElement("img");
    baseImg.id = "gelly-image";
    if (stage === "egg") {
        baseImg.src = `assets/egg.png`;
    } else if (stage === "blob") {
        baseImg.src = `assets/blob-${color}.png`;
    } else {
        baseImg.src = `assets/gelly-${color}.png`;
    }
    container.appendChild(baseImg);

    // Add equipped accessories
    equippedItems
        .filter(item => item.equipped)
        .forEach(item => {
            const accessoryImg = document.createElement("img");
            accessoryImg.className = "accessory-layer";
            accessoryImg.src = `assets/${item.itemId}.png`;
            accessoryImg.alt = item.name;
            container.appendChild(accessoryImg);
        });
}

async function fetchInventory() {
    try {
        const res = await fetch(`https://gelly-server.onrender.com/v1/inventory/${twitchUserId}`, {
            headers: { "Authorization": `Bearer ${twitchAuthToken}` }
        });
        const data = await res.json();
        if (data.success) {
            renderInventory(data.inventory);
        }
    } catch (err) {
        console.error("Failed to fetch inventory:", err);
    }
}

function renderInventory(items) {
    const invContainer = document.getElementById("inventory");
    invContainer.innerHTML = "";
    items.forEach(item => {
        const div = document.createElement("div");
        div.className = "inventory-item";
        div.textContent = item.name + (item.equipped ? " (Equipped)" : "");
        div.addEventListener("click", () => equipItem(item.itemId, !item.equipped));
        invContainer.appendChild(div);
    });

    // Update Gelly with equipped accessories
    updateGellyImage(currentStage, "blue", items);
}

async function equipItem(itemId, equipped) {
    try {
        const res = await fetch(`https://gelly-server.onrender.com/v1/inventory/equip`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${twitchAuthToken}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ userId: twitchUserId, itemId, equipped })
        });
        const data = await res.json();
        if (data.success) {
            renderInventory(data.inventory);
        }
    } catch (err) {
        console.error("Equip failed:", err);
    }
}

// ===== Store =====
async function fetchStore() {
    try {
        const res = await fetch(`https://gelly-server.onrender.com/v1/store`);
        const data = await res.json();
        if (data.success) {
            renderStore(data.store);
        }
    } catch (err) {
        console.error("Failed to fetch store:", err);
    }
}
// Open Store
document.getElementById("openStoreBtn").addEventListener("click", () => {
    document.getElementById("gelly-container").style.display = "none";
    document.getElementById("store-menu").style.display = "block";
});

// Back to Game
document.getElementById("backToGameBtn").addEventListener("click", () => {
    document.getElementById("store-menu").style.display = "none";
    document.getElementById("gelly-container").style.display = "block";
});

function renderStore(items) {
    const storeContainer = document.getElementById("store");
    storeContainer.innerHTML = "";

    items.forEach(item => {
        const itemDiv = document.createElement("div");
        itemDiv.className = "store-item";

        const img = document.createElement("img");
        img.src = `assets/${item.id}.png`; // exact asset filename match
        img.alt = item.name;

        const nameEl = document.createElement("p");
        nameEl.textContent = item.name;

        const costEl = document.createElement("p");
        costEl.textContent = `${item.cost} ${item.currency}`;

        const buyBtn = document.createElement("button");
        buyBtn.textContent = `Buy`;
        buyBtn.addEventListener("click", () => {
            if (item.currency === "jellybeans") {
                buyWithJellybeans(item);
            } else if (item.currency === "bits") {
                buyWithBits(item);
            }
        });

        itemDiv.appendChild(img);
        itemDiv.appendChild(nameEl);
        itemDiv.appendChild(costEl);
        itemDiv.appendChild(buyBtn);
        storeContainer.appendChild(itemDiv);
    });
}

// ===== Buy Jellybean Item =====
async function buyWithJellybeans(item) {
    try {
        const res = await fetch(`https://gelly-server.onrender.com/v1/inventory/buy`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${twitchAuthToken}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                userId: twitchUserId,
                itemId: item.id,
                name: item.name,
                type: item.type,
                cost: item.cost,
                currency: "jellybeans"
            })
        });
        const data = await res.json();
        if (data.success) {
            showTempMessage(`Purchased ${item.name}!`);
            renderInventory(data.inventory);
            updateGellyImage(currentStage, "blue", data.inventory);
            fetchJellybeanBalance();
        } else {
            showTempMessage(data.message || "Purchase failed");
        }
    } catch (err) {
        console.error("Buy Jellybeans failed:", err);
    }
}

// ===== Buy Bits Item =====
async function buyWithBits(item) {
    try {
        Twitch.ext.bits.getProducts()
            .then(products => {
                const product = products.find(p => p.sku === item.id);
                if (!product) {
                    showTempMessage("Bits product not found");
                    return;
                }
                return Twitch.ext.bits.purchase(product.sku);
            })
            .then(() => {
                // Twitch will send a transaction receipt via onTransactionComplete
            })
            .catch(err => {
                console.error("Bits purchase failed:", err);
                showTempMessage("Bits purchase failed");
            });
    } catch (err) {
        console.error("Buy Bits failed:", err);
    }
}

// ===== Listen for Bits purchase confirmation =====
if (Twitch.ext.bits) {
    Twitch.ext.bits.onTransactionComplete(transaction => {
        fetch(`https://gelly-server.onrender.com/v1/inventory/buy`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${twitchAuthToken}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                userId: twitchUserId,
                itemId: transaction.product.sku,
                name: transaction.product.displayName,
                type: "unknown",
                cost: transaction.product.cost.amount,
                currency: "bits",
                transactionId: transaction.transactionId
            })
        })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                showTempMessage(`Purchased ${transaction.product.displayName}!`);
                renderInventory(data.inventory);
                updateGellyImage(currentStage, "blue", data.inventory);
            } else {
                showTempMessage(data.message || "Bits purchase failed");
            }
        })
        .catch(err => console.error("Transaction verification failed:", err));
    });
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

    // === Inventory + Store visibility ===
    if (state.stage !== "egg") {
    document.getElementById("openInventoryBtn").style.display = "inline-block";
    document.getElementById("openStoreBtn").style.display = "inline-block";
} else {
    document.getElementById("openInventoryBtn").style.display = "none";
    document.getElementById("openStoreBtn").style.display = "none";
}


        // Directly use inventory from state if available
        if (Array.isArray(state.inventory)) {
            renderInventory(state.inventory);
            renderEquippedAccessories(state.inventory);
        } else {
            fetchInventory().then(() => {
                if (Array.isArray(state.inventory)) {
                    renderEquippedAccessories(state.inventory);
                }
            });
        }

        fetchStore();
    } else {
        document.getElementById("inventory-section").style.display = "none";
        document.getElementById("store-section").style.display = "none";
        clearEquippedAccessories();
    }
}

// === Render Equipped Accessories ===
function renderEquippedAccessories(inventory) {
    const gellyContainer = document.getElementById("background");

    // Remove old accessories
    document.querySelectorAll(".equipped-accessory").forEach(el => el.remove());

    // Add equipped items on top of Gelly
    inventory.filter(item => item.equipped).forEach(item => {
        const img = document.createElement("img");
        img.src = `assets/${item.itemId}.png`; // exact asset filename match
        img.alt = item.name;
        img.className = "equipped-accessory";
        img.style.position = "absolute";
        img.style.pointerEvents = "none";
        img.style.zIndex = "10"; // above Gelly
        img.style.top = "0"; // adjust for positioning
        img.style.left = "50%";
        img.style.transform = "translateX(-50%)";
        img.style.maxWidth = "100px"; // scale accessory

        gellyContainer.appendChild(img);
    });
}

// === Clear accessories ===
function clearEquippedAccessories() {
    document.querySelectorAll(".equipped-accessory").forEach(el => el.remove());
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
            return; // ❌ Don't start cooldown if server failed
        }

        // ✅ Only start cooldown when success is true
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

        // Update UI from latest state
        if (data.state) {
            updateUIFromState(data.state);
        }

        if (action === "feed" || action === "play" || action === "clean") {
            triggerGellyAnimation(action);
        }
        if (action.startsWith("color:")) {
            triggerColorChangeEffect();
        }
        animateGelly();

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
        // ❌ No cooldown on network/server error
    }
}
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
                startGame(); // ✅ Only show game after state loads
            }
        }
    } catch (err) {
        console.error("[ERROR] Fetching state failed:", err);
    }
    connectWebSocket();
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
    startKeepAlive();

    if (twitchUserId.startsWith("U") && localStorage.getItem("linkedOnce") !== "true") {
        console.log("⚠️ User is opaque — needs to link");
        showLinkButton();
        return;
    }
    initGame();
});

function startKeepAlive() {
    setInterval(() => {
        fetch("https://gelly-server.onrender.com/ping")
            .then(res => res.json())
            .then(data => console.log("Keep-alive ping:", data.message))
            .catch(err => console.warn("Keep-alive failed:", err));
    }, 50000);
}



// ===== Action Buttons =====
document.getElementById("feedBtn")?.addEventListener("click", () => interact("feed"));
document.getElementById("playBtn")?.addEventListener("click", () => interact("play"));
document.getElementById("cleanBtn")?.addEventListener("click", () => interact("clean"));
document.getElementById("startGameBtn")?.addEventListener("click", () => {
    initGame(); // ✅ Load game state and then start game
});


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
// ===== Open / Close Inventory =====
document.getElementById("openInventoryBtn").addEventListener("click", () => {
    document.getElementById("gelly-container").style.display = "none";
    document.getElementById("inventory-menu").style.display = "block";
});
document.getElementById("backFromInventoryBtn").addEventListener("click", () => {
    document.getElementById("inventory-menu").style.display = "none";
    document.getElementById("gelly-container").style.display = "block";
});

// ===== Open / Close Store =====
document.getElementById("openStoreBtn").addEventListener("click", () => {
    document.getElementById("gelly-container").style.display = "none";
    document.getElementById("store-menu").style.display = "block";
});
document.getElementById("backFromStoreBtn").addEventListener("click", () => {
    document.getElementById("store-menu").style.display = "none";
    document.getElementById("gelly-container").style.display = "block";
});

