<<<<<<< HEAD
// scripts/update-twitch-token.js
const fs = require("fs");
const path = require("path");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
require("dotenv").config();

const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const ENV_FILE = path.join(__dirname, "../.env");

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("❌ Missing TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET in .env");
  process.exit(1);
}

async function updateToken() {
  try {
    console.log("🔄 Requesting new Twitch App Access Token...");

    const res = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "client_credentials",
      }),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    const token = data.access_token;

    console.log("✅ Got new token:", token);

    // Read .env
    let envContent = fs.readFileSync(ENV_FILE, "utf-8");

    // Update or add TWITCH_APP_ACCESS_TOKEN
    if (envContent.includes("TWITCH_APP_ACCESS_TOKEN=")) {
      envContent = envContent.replace(
        /TWITCH_APP_ACCESS_TOKEN=.*/g,
        `TWITCH_APP_ACCESS_TOKEN=${token}`
      );
    } else {
      envContent += `\nTWITCH_APP_ACCESS_TOKEN=${token}`;
    }

    fs.writeFileSync(ENV_FILE, envContent);
    console.log(`💾 Updated ${ENV_FILE} with new token`);
  } catch (err) {
    console.error("❌ Failed to update Twitch token:", err);
  }
}

updateToken();
=======
// scripts/update-twitch-token.js
const fs = require("fs");
const path = require("path");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
require("dotenv").config();

const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const ENV_FILE = path.join(__dirname, "../.env");

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("❌ Missing TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET in .env");
  process.exit(1);
}

async function updateToken() {
  try {
    console.log("🔄 Requesting new Twitch App Access Token...");

    const res = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "client_credentials",
      }),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    const token = data.access_token;

    console.log("✅ Got new token:", token);

    // Read .env
    let envContent = fs.readFileSync(ENV_FILE, "utf-8");

    // Update or add TWITCH_APP_ACCESS_TOKEN
    if (envContent.includes("TWITCH_APP_ACCESS_TOKEN=")) {
      envContent = envContent.replace(
        /TWITCH_APP_ACCESS_TOKEN=.*/g,
        `TWITCH_APP_ACCESS_TOKEN=${token}`
      );
    } else {
      envContent += `\nTWITCH_APP_ACCESS_TOKEN=${token}`;
    }

    fs.writeFileSync(ENV_FILE, envContent);
    console.log(`💾 Updated ${ENV_FILE} with new token`);
  } catch (err) {
    console.error("❌ Failed to update Twitch token:", err);
  }
}

updateToken();
>>>>>>> 42ef2ca755056ceba5a0a12e197b16a2ddcb598b
