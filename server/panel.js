// ===== Gelly Extension Panel Script =====
let twitchUserId = null;
let twitchAuthToken = null;
let loginName = null;
let jellybeanBalance = 0;
let currentStage = "egg";
let currentColor = "blue";
let latestInventory = []; // cache to keep store stable
// Re-entrant auth guards (react only when token/user actually changes)
let lastAuthUserId = null;
let lastAuthToken = null;

let colorPending = null;     // currently-requested color (if any)
let colorGuardUntil = 0;     // ignore stale WS color updates until this timestamp

function setColorButtonsDisabled(disabled) {
  document.querySelectorAll(".color-btn").forEach(b => { b.disabled = !!disabled; });
}

// ===== UI Elements =====
const jellybeanBalanceEl = document.getElementById("jellybeanBalance");
const energyEl = document.getElementById("energy");
const moodEl = document.getElementById("mood");
const cleanlinessEl = document.getElementById("cleanliness");
const leaderboardList = document.getElementById("leaderboard-list");
const messageEl = document.getElementById("message");
const COLOR_CHANGE_COST = 50000;

// show message even if store is open
function storeToast(msg) {
  const storeMenu = document.getElementById("store-menu");
  let toast = document.getElementById("store-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "store-toast";
    toast.style.position = "fixed";
    toast.style.left = "50%";
    toast.style.top = "12px";
    toast.style.transform = "translateX(-50%)";
    toast.style.padding = "8px 12px";
    toast.style.background = "rgba(0,0,0,0.8)";
    toast.style.color = "#fff";
    toast.style.borderRadius = "6px";
    toast.style.fontSize = "14px";
    toast.style.zIndex = "99999";
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.display = "block";
  setTimeout(() => (toast.style.display = "none"), 2500);
}
// ===== Bits (catalog cache + optional SKU mapping) =====
let bitsProducts = [];
// If your Twitch SKUs differ from store item IDs, map them here:
const BITS_SKU_MAP = {
  // "gold-crown": "gold_crown_sku",
  // "sword": "sword_sku",
  // "king-crown": "royal_crown_sku",
  // "gun": "m4_sku",
};

async function refreshBitsProducts() {
  if (!window.Twitch?.ext?.bits) return [];
  try {
    const products = await Twitch.ext.bits.getProducts();
    bitsProducts = Array.isArray(products) ? products : [];
    console.log("[BITS] getProducts →", bitsProducts.map(p => ({
      sku: p.sku, cost: p.cost?.amount, inDev: p.inDevelopment
    })));
    return bitsProducts;
  } catch (err) {
    console.error("[BITS] getProducts failed:", err);
    bitsProducts = [];
    return bitsProducts;
  }
}

function findSkuForItem(itemId) {
  // exact match or mapped SKU
  const want = BITS_SKU_MAP[itemId] || itemId;
  const hit = bitsProducts.find(p => p.sku === want);
  return hit?.sku || null;
}

// ===== Link Account Button =====
function showLinkButton() {
  const linkBtn = document.getElementById("linkAccountBtn");
  if (!linkBtn) return;
  linkBtn.style.display = "block";
  linkBtn.onclick = () => {
    try {
      Twitch.ext.actions.requestIdShare();
      // Hide immediately for UX; Twitch should re-fire onAuthorized with real user_id on success
      linkBtn.style.display = "none";
      // Fallback: if re-auth is slow, still start as guest; server will switch once token includes user_id
      setTimeout(() => initGame(), 900);
    } catch (e) {
      console.warn("[LINK] requestIdShare error", e);
    }
  };
}
function hideLinkButton() {
  const linkBtn = document.getElementById("linkAccountBtn");
  if (linkBtn) {
    linkBtn.style.display = "none";
    linkBtn.onclick = null;
  }
}

// ===== Utility =====
function showTempMessage(msg) {
  messageEl.textContent = msg;
  setTimeout(() => (messageEl.textContent = ""), 3000);
}
const getGellyImg = () => document.getElementById("gelly-image");

function playAnim(cls) {
  const img = getGellyImg();
  if (!img) return;
  img.classList.remove("gelly-feed-anim", "gelly-play-anim", "gelly-clean-anim", "bounce");
  void img.offsetWidth;
  img.classList.add(cls);
  setTimeout(() => img.classList.remove(cls), 800);
}
function triggerGellyAnimation(action) {
  if (action === "feed") playAnim("gelly-feed-anim");
  else if (action === "play") playAnim("gelly-play-anim");
  else if (action === "clean") playAnim("gelly-clean-anim");
}
function animateGelly() {
  const img = getGellyImg();
  if (!img) return;
  img.classList.remove("bounce");
  void img.offsetWidth;
  img.classList.add("bounce");
  setTimeout(() => img.classList.remove("bounce"), 800);
}
function triggerColorChangeEffect() {
  const container = document.getElementById("gelly-container");
  if (!container) return;

  // Ensure sparkles element exists INSIDE the container
  let spark = document.getElementById("evolution-sparkles");
  if (!spark) {
    spark = document.createElement("div");
    spark.id = "evolution-sparkles";
    container.appendChild(spark);
  } else if (spark.parentElement !== container) {
    container.appendChild(spark);
  }

  // Retrigger animation: remove → force reflow → add
  container.classList.remove("evolution-active");
  spark.classList.remove("spark-run");
  // force reflow
  void spark.offsetWidth;

  container.classList.add("evolution-active");
  spark.classList.add("spark-run");

  // cleanup container flag after animation finishes
  setTimeout(() => container.classList.remove("evolution-active"), 2600);
}

// Apply color locally + sparkle if actually changed
function applyColorLocally(newColor) {
  if (!newColor) return;
  const changed = newColor !== currentColor;
  currentColor = newColor;
  updateGellyImage(currentStage, currentColor);
  if (changed) triggerColorChangeEffect();
}

// Enable/disable color changing based on balance
function updateColorPickerButtons() {
  const colorSelect = document.getElementById("gellyColor");
  if (colorSelect) colorSelect.disabled = jellybeanBalance < COLOR_CHANGE_COST;
}

// ===== Gelly Image =====
function updateGellyImage(stage, color) {
  const container = document.getElementById("background");
  let img = document.getElementById("gelly-image");
  const src =
    stage === "egg" ? "assets/egg.png" :
    stage === "blob" ? `assets/blob-${color}.png` :
    `assets/gelly-${color}.png`;
  if (img) { img.src = src; return; }
  img = document.createElement("img");
  img.id = "gelly-image";
  img.src = src;
  container.appendChild(img);
}

// ===== Inventory =====
async function fetchInventory(userId) {
  try {
    const url = `https://gelly-server.onrender.com/v1/inventory/${encodeURIComponent(userId)}`;
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${twitchAuthToken}`, "Content-Type": "application/json" },
    });
    if (!res.ok) {
      console.warn("[INV] fetchInventory HTTP", res.status);
      return { success: false, inventory: [] };
    }
    const data = await res.json();
    console.log("[INV] fetchInventory →", res.status, data);
    return data;
  } catch (e) {
    console.warn("[INV] fetchInventory error", e);
    return { success: false, inventory: [] };
  }
}

function renderInventory(items = []) {
  latestInventory = Array.isArray(items) ? items : [];
  const invContainer = document.getElementById("inventory");
  invContainer.innerHTML = "";

  if (!Array.isArray(items) || items.length === 0) {
    invContainer.textContent = "Your inventory is empty.";
    renderEquippedAccessories([]);
    return;
  }

  items.forEach((item) => {
    const div = document.createElement("div");
    div.className = "inventory-item";
    if (item.equipped) div.classList.add("equipped");

    const img = document.createElement("img");
    img.src = `assets/${item.itemId}.png`;
    img.alt = item.name || item.itemId;
    img.className = "inventory-thumb";

    const nameEl = document.createElement("p");
    nameEl.textContent = item.name || item.itemId;

    const equipBtn = document.createElement("button");
    equipBtn.textContent = item.equipped ? "Unequip" : "Equip";
    equipBtn.onclick = () => equipItem(item.itemId, !item.equipped);

    div.appendChild(img);
    div.appendChild(nameEl);
    div.appendChild(equipBtn);
    invContainer.appendChild(div);
  });

  updateGellyImage(currentStage, currentColor);
  renderEquippedAccessories(items);
}

async function equipItem(itemId, equipped) {
  try {
    const res = await fetch(`https://gelly-server.onrender.com/v1/inventory/equip`, {
      method: "POST",
      headers: { Authorization: `Bearer ${twitchAuthToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ userId: twitchUserId, itemId, equipped }),
    });
    const data = await res.json().catch(() => ({}));
    console.log("[INV] equip →", res.status, data);
    if (!res.ok || !data.success) {
      const msg = data?.message || `Equip failed (${res.status})`;
      showTempMessage(msg);
      storeToast(msg);
      return;
    }
    latestInventory = data.inventory || latestInventory;
    renderInventory(latestInventory);
    renderEquippedAccessories(latestInventory);
    animateGelly();
    if (document.getElementById("store-menu")?.style.display === "block") fetchStore();
  } catch (err) {
    console.error("[INV] equip error:", err);
    showTempMessage("Equip failed");
    storeToast("Equip failed");
  }
}

// ===== Store =====
async function fetchStore() {
  try {
    const res = await fetch(`https://gelly-server.onrender.com/v1/store`);
    const data = await res.json();
    console.log("[STORE] fetch →", res.status, data);
    if (res.ok && data.success) renderStore(data.store, latestInventory);
  } catch (err) {
    console.error("[STORE] fetch error:", err);
  }
}

async function renderStore(items = []) {
  const storeContainer = document.getElementById("store");
  storeContainer.innerHTML = "";

  // Ensure we have the latest inv + bits catalog
  const [inventoryData] = await Promise.all([
    fetchInventory(twitchUserId),
    refreshBitsProducts(), // harmless if already cached
  ]);
  const ownedItems = (inventoryData.inventory || []).map((i) => (i.itemId || "").toLowerCase());

  items.forEach((item) => {
    const itemDiv = document.createElement("div");
    itemDiv.className = "store-item";

    const img = document.createElement("img");
    img.src = `assets/${item.id}.png`;
    img.alt = item.name;

    const nameEl = document.createElement("p");
    nameEl.textContent = item.name;

    const costEl = document.createElement("p");
    costEl.textContent = `${item.cost} ${item.currency}`;

    const buyBtn = document.createElement("button");

    if (ownedItems.includes((item.id || "").toLowerCase())) {
      buyBtn.textContent = "Owned";
      buyBtn.disabled = true;
      buyBtn.style.backgroundColor = "#aaa";
      buyBtn.style.cursor = "not-allowed";
    } else if (item.currency === "bits") {
      const sku = findSkuForItem(item.id);
      if (!sku) {
        buyBtn.textContent = "Unavailable";
        buyBtn.disabled = true;
        buyBtn.title = "Bits product not configured for this SKU";
        console.warn("[BITS] No SKU for item:", item.id, "Available SKUs:", bitsProducts.map(p => p.sku));
      } else {
        buyBtn.textContent = "Buy (Bits)";
        buyBtn.addEventListener("click", () => buyWithBits(item, sku));
      }
    } else {
      buyBtn.textContent = "Buy";
      buyBtn.addEventListener("click", () => buyWithJellybeans(item));
    }

    itemDiv.appendChild(img);
    itemDiv.appendChild(nameEl);
    itemDiv.appendChild(costEl);
    itemDiv.appendChild(buyBtn);
    storeContainer.appendChild(itemDiv);
  });
}


async function buyWithJellybeans(item) {
  try {
    const payload = {
      userId: twitchUserId,
      itemId: item.id,
      name: item.name,
      type: item.type,
      cost: item.cost,
      currency: "jellybeans",
    };
    const res = await fetch(`https://gelly-server.onrender.com/v1/inventory/buy`, {
      method: "POST",
      headers: { Authorization: `Bearer ${twitchAuthToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    console.log("[BUY] jellybeans →", res.status, data);

    if (!res.ok || !data.success) {
      const msg = data?.message || `Purchase failed (${res.status})`;
      showTempMessage(msg);
      storeToast(msg);
      return;
    }

    showTempMessage(`Purchased ${item.name}!`);
    storeToast(`Purchased ${item.name}!`);
    latestInventory = data.inventory || latestInventory;
    renderInventory(latestInventory);
    updateGellyImage(currentStage, currentColor);
    renderEquippedAccessories(latestInventory);
    fetchJellybeanBalance();
    animateGelly();

    if (document.getElementById("store-menu")?.style.display === "block") fetchStore();
  } catch (err) {
    console.error("[BUY] jellybeans error:", err);
    showTempMessage("Purchase failed");
    storeToast("Purchase failed");
  }
}

async function buyWithBits(item, skuFromCatalog) {
  try {
    if (!window.Twitch?.ext?.bits || typeof Twitch.ext.bits.useBits !== "function") {
      showTempMessage("Bits not available in this context");
      return;
    }
    // Prefer the SKU already found in renderStore; if not, try to resolve now.
    let sku = skuFromCatalog || findSkuForItem(item.id);
    if (!sku) {
      // One more refresh, then give up
      await refreshBitsProducts();
      sku = findSkuForItem(item.id);
    }
    if (!sku) {
      console.warn("[BITS] Product not found for item:", item.id, "SKUs:", bitsProducts.map(p => p.sku));
      showTempMessage("Bits product not found");
      return;
    }

    console.log("[BITS] Purchasing", { itemId: item.id, sku });
    // Correct Twitch Extensions call
    Twitch.ext.bits.useBits(sku);
  } catch (err) {
    console.error("Bits purchase failed:", err);
    showTempMessage("Bits purchase failed");
  }
}

if (window.Twitch?.ext?.bits) {
  Twitch.ext.bits.onTransactionComplete((transaction) => {
    console.log("[BITS] onTransactionComplete:", transaction);
    fetch(`https://gelly-server.onrender.com/v1/inventory/buy`, {
      method: "POST",
      headers: { Authorization: `Bearer ${twitchAuthToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: twitchUserId,
        itemId: transaction.product.sku,  // server will look up name/type/cost from store
        currency: "bits",
        transactionId: transaction.transactionId,
      }),
    })
      .then((res) => res.json())
      .then((data) => {
        console.log("[BITS] verify →", data);
        if (data.success) {
          showTempMessage(`Purchased ${transaction.product.displayName || transaction.product.sku}!`);
          renderInventory(data.inventory || []);
          updateGellyImage(currentStage, currentColor);
          renderEquippedAccessories(data.inventory || []);
          animateGelly();
          fetchStore();
        } else {
          showTempMessage(data.message || "Bits purchase failed");
        }
      })
      .catch((err) => console.error("Transaction verification failed:", err));
  });
}


// ===== Cooldown Tracking =====
const cooldowns = {};
const isOnCooldown = (action) => cooldowns[action] && Date.now() < cooldowns[action];
const setCooldown = (action, ms) => (cooldowns[action] = Date.now() + ms);

// ===== Jellybean Balance =====
async function fetchJellybeanBalance() {
  if (!loginName) return;
  try {
    const res = await fetch(`https://gelly-server.onrender.com/v1/points/${loginName}`);
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
  // ✅ keep currentStage in sync with server
  currentStage = state.stage || currentStage;

  // ✅ accept server color unless guarding against stale WS, BUT accept if it matches the pending color
  const now = Date.now();
  if (state.color) {
    if (!colorPending || now > colorGuardUntil || state.color === colorPending) {
      applyColorLocally(state.color);
    }
  }

  energyEl.textContent = Math.floor(state.energy ?? 0);
  moodEl.textContent = Math.floor(state.mood ?? 0);
  cleanlinessEl.textContent = Math.floor(state.cleanliness ?? 0);

  // ensure image reflects the final stage/color combo
  updateGellyImage(currentStage, currentColor);

  if (Array.isArray(state.inventory)) {
    latestInventory = state.inventory;
  }

  const openInvBtn = document.getElementById("openInventoryBtn");
  const openStoreBtn = document.getElementById("openStoreBtn");

  if (state.stage !== "egg") {
    if (openInvBtn) openInvBtn.style.display = "inline-block";
    if (openStoreBtn) openStoreBtn.style.display = "inline-block";
    if (Array.isArray(state.inventory)) {
      renderInventory(state.inventory);
    }
  } else {
    if (openInvBtn) openInvBtn.style.display = "none";
    if (openStoreBtn) openStoreBtn.style.display = "none";
    document.getElementById("inventory-menu")?.style?.setProperty("display", "none");
    document.getElementById("store-menu")?.style?.setProperty("display", "none");
    clearEquippedAccessories();
  }
}


// Equipped overlays
function renderEquippedAccessories(inventory = []) {
  const gellyContainer = document.getElementById("background");
  document.querySelectorAll(".equipped-accessory").forEach((el) => el.remove());
  inventory.filter((item) => item.equipped).forEach((item) => {
    const img = document.createElement("img");
    img.src = `assets/${item.itemId}.png`;
    img.alt = item.name || item.itemId;
    img.className = `equipped-accessory type-${item.type || "accessory"}`;
    gellyContainer.appendChild(img);
  });
}
function clearEquippedAccessories() {
  document.querySelectorAll(".equipped-accessory").forEach((el) => el.remove());
}

// Leaderboard
function updateLeaderboard(entries) {
  leaderboardList.innerHTML = "";
  entries.forEach((entry) => {
    const li = document.createElement("li");
    li.textContent = `${entry.displayName || entry.loginName}: ${entry.score} care score`;
    leaderboardList.appendChild(li);
  });
}

// Interact
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
      headers: { Authorization: `Bearer ${twitchAuthToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ user: twitchUserId, action }),
    });
    const data = await res.json().catch(() => ({}));
    console.log("[ACT] interact →", action, res.status, data);

    if (!res.ok || !data.success) {
      const msg = data?.message || `Action failed (${res.status})`;
      showTempMessage(msg);
      return;
    }

    if (action === "feed" || action === "play" || action === "clean") triggerGellyAnimation(action);
    else if (action.startsWith("color:")) triggerColorChangeEffect();

    setCooldown(cooldownKey, cooldownMs);
    if (button) {
      const originalText = button.textContent;
      let remaining = Math.floor(cooldownMs / 1000);
      button.disabled = true;
      button.textContent = `${originalText} (${remaining}s)`;
      const interval = setInterval(() => {
        remaining -= 1;
        if (remaining > 0) button.textContent = `${originalText} (${remaining}s)`;
        else { clearInterval(interval); button.disabled = false; button.textContent = originalText; }
      }, 1000);
    }

    if (data.state) updateUIFromState(data.state);
    if (typeof data.newBalance === "number") {
      jellybeanBalance = data.newBalance;
      jellybeanBalanceEl.textContent = jellybeanBalance.toLocaleString();
      updateColorPickerButtons();
    } else {
      await fetchJellybeanBalance();
      updateColorPickerButtons();
    }
  } catch (err) {
    console.error("[ACT] interact error:", err);
    showTempMessage("Action failed");
  }
}

// Init
async function initGame() {
  console.log("Starting game for user:", twitchUserId);
  try {
    const res = await fetch(`https://gelly-server.onrender.com/v1/state/${encodeURIComponent(twitchUserId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${twitchAuthToken}`, "Content-Type": "application/json" },
    });
    if (res.ok) {
      const data = await res.json();
      console.log("[STATE] init →", data);
      if (data.success) {
        updateUIFromState(data.state);
        loginName = data.state.loginName;
        await fetchJellybeanBalance();
        // If no inventory arrived in state, fetch once now
        if (!Array.isArray(data.state.inventory)) {
          const inv = await fetchInventory(twitchUserId);
          renderInventory(inv.inventory || []);
        }
      }
    }
  } catch (err) {
    console.error("[ERROR] Fetching state failed:", err);
  }
  connectWebSocket();
  startGame();
}

function startGame() {
  const startScreen = document.getElementById("landing-page");
  const gameScreen = document.getElementById("gelly-container");
  if (!startScreen || !gameScreen) return;
  startScreen.style.display = "none";
  gameScreen.style.display = "block";
}

// WebSocket
let ws;
function connectWebSocket() {
  if (!twitchUserId) return;
  // Close any existing connection before opening a new one
  try {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close();
  } catch {}
  // no extra "/" before ?user
  ws = new WebSocket(`wss://gelly-server.onrender.com?user=${encodeURIComponent(twitchUserId)}`);
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "update") updateUIFromState(msg.state);
    else if (msg.type === "leaderboard") updateLeaderboard(msg.entries);
  };
  ws.onerror = (e) => console.warn("[WS] error", e);
  ws.onclose = () => console.log("[WS] closed");
}

// Single, re-entrant onAuthorized (preload bits then init/Link)
Twitch.ext.onAuthorized(function (auth) {
  // React only if auth changed
  if (auth.userId === lastAuthUserId && auth.token === lastAuthToken) return;
  lastAuthUserId = auth.userId;
  lastAuthToken = auth.token;

  console.log("Authorized with ID:", auth.userId);
  twitchUserId = auth.userId;
  twitchAuthToken = auth.token;

  // Preload bits catalog (safe if bits is unavailable; it no-ops)
  refreshBitsProducts().finally(() => {
    if (twitchUserId && twitchUserId.startsWith("U")) {
      showLinkButton();
    } else {
      hideLinkButton();
      initGame();
    }
  });
});

// Keep-alive
setInterval(() => {
  fetch("https://gelly-server.onrender.com/ping")
    .then((res) => res.json())
    .then((data) => console.log("Keep-alive ping:", data.message))
    .catch((err) => console.warn("Keep-alive failed:", err));
}, 50000);

// Buttons
const safeBind = (id, event, handler) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener(event, handler);
};

safeBind("feedBtn", "click", () => interact("feed"));
safeBind("playBtn", "click", () => interact("play"));
safeBind("cleanBtn", "click", () => interact("clean"));
safeBind("startGameBtn", "click", () => initGame());

// Help
safeBind("helpBtn", "click", () => {
  const helpBox = document.getElementById("help-box");
  const helpBtn = document.getElementById("helpBtn");
  if (helpBox && helpBtn) {
    const open = helpBox.style.display === "block";
    helpBox.style.display = open ? "none" : "block";
    helpBtn.textContent = open ? "Help" : "Close Help";
  }
});

// Inventory open/close
safeBind("openInventoryBtn", "click", async () => {
  const game = document.getElementById("gelly-container");
  const inv = document.getElementById("inventory-menu");
  if (game) game.style.display = "none";
  if (inv) inv.style.display = "block";
  // Make sure we show current inventory when opening
  const data = await fetchInventory(twitchUserId);
  renderInventory(data.inventory || []);
});
safeBind("backFromInventoryBtn", "click", () => {
  const game = document.getElementById("gelly-container");
  const inv = document.getElementById("inventory-menu");
  if (inv) inv.style.display = "none";
  if (game) game.style.display = "block";
});

// Store open/close
safeBind("openStoreBtn", "click", () => {
  const game = document.getElementById("gelly-container");
  const store = document.getElementById("store-menu");
  if (game) game.style.display = "none";
  if (store) {
    store.style.display = "block";
    fetchStore(); // fetch once when opening
  }
});
safeBind("backFromStoreBtn", "click", () => {
  const game = document.getElementById("gelly-container");
  const store = document.getElementById("store-menu");
  if (store) store.style.display = "none";
  if (game) game.style.display = "block";
});

async function changeColor(nextColor) {
  if (!twitchUserId || !twitchAuthToken) return;
  if (colorPending) return; // drop double-clicks

  colorPending = nextColor;
  setColorButtonsDisabled(true);
  try {
    // reuse your /v1/interact endpoint for color
    const res = await fetch("https://gelly-server.onrender.com/v1/interact", {
      method: "POST",
      headers: { Authorization: `Bearer ${twitchAuthToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ user: twitchUserId, action: `color:${nextColor}` }),
    });
    const data = await res.json().catch(() => ({}));
    console.log("[COLOR] change →", nextColor, res.status, data);

    if (!res.ok || !data.success) {
      showTempMessage(data?.message || `Color change failed (${res.status})`);
      return;
    }

    // Guard against stale WS; apply locally immediately (with sparkle)
    colorGuardUntil = Date.now() + 2000;
    applyColorLocally(nextColor);

    // If server returns state, let it confirm/normalize
    if (data.state) updateUIFromState(data.state);

    if (typeof data.newBalance === "number") {
      jellybeanBalance = data.newBalance;
      jellybeanBalanceEl.textContent = jellybeanBalance.toLocaleString();
      updateColorPickerButtons();
    } else {
      await fetchJellybeanBalance();
    }
  } catch (err) {
    console.error("[COLOR] change error:", err);
    showTempMessage("Color change failed");
  } finally {
    colorPending = null;
    setColorButtonsDisabled(false);
  }
}

// Color buttons
document.querySelectorAll(".color-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const selectedColor = btn.dataset.color;
    changeColor(selectedColor);
  });
});
