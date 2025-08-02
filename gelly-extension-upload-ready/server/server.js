// ===== WebSocket Setup =====
const server = require("http").createServer(app);

// Important: use same server for WebSocket
const wss = new WebSocket.Server({ server });

// Store connections keyed by userId
const clients = new Map();

wss.on("connection", (ws, req) => {
  try {
    // Render + Twitch passes full URL in req.url (e.g., "/?user=U12345")
    const searchParams = new URL(req.url, `http://${req.headers.host}`).searchParams;
    const userId = searchParams.get("user");

    if (userId) {
      clients.set(userId, ws);
      console.log(`🔌 WebSocket connected for user: ${userId}`);
    } else {
      console.warn("⚠️ WebSocket connection without userId");
      ws.close(1008, "User ID required"); // Policy Violation close code
      return;
    }

    // Send confirmation to client
    ws.send(JSON.stringify({
      type: "connected",
      message: `Connected to Gelly server as ${userId}`
    }));

    // Handle incoming messages (if needed later)
    ws.on("message", (msg) => {
      console.log(`💬 WS message from ${userId}:`, msg.toString());
    });

    ws.on("close", () => {
      if (userId) {
        clients.delete(userId);
        console.log(`❌ WebSocket disconnected for user: ${userId}`);
      }
    });

    ws.on("error", (err) => {
      console.error(`🚨 WebSocket error for user: ${userId}`, err);
    });

  } catch (e) {
    console.error("🚨 Error in WebSocket handler:", e);
  }
});

// Broadcast a state update to a specific user
function broadcastState(userId, gelly) {
  const ws = clients.get(userId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "update", state: gelly }));
  }
}

// Broadcast leaderboard to all users
async function sendLeaderboard() {
  const leaderboard = await Gelly.find()
    .sort({ points: -1, mood: -1, energy: -1, cleanliness: -1 })
    .limit(10)
    .lean();

  const data = JSON.stringify({ type: "leaderboard", entries: leaderboard });
  for (const [, ws] of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}
