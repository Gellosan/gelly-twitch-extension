<<<<<<< HEAD
// backfill-loginName.js
require("dotenv").config();
const mongoose = require("mongoose");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const Gelly = require("./Gelly.js");

const MONGODB_URI = process.env.MONGODB_URI;
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_APP_ACCESS_TOKEN = process.env.TWITCH_APP_ACCESS_TOKEN;

async function fetchTwitchUserData(userId) {
  try {
    const res = await fetch(`https://api.twitch.tv/helix/users?id=${userId}`, {
      headers: {
        "Client-ID": TWITCH_CLIENT_ID,
        "Authorization": `Bearer ${TWITCH_APP_ACCESS_TOKEN}`
      }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const user = data?.data?.[0];
    return user
      ? { displayName: user.display_name, loginName: user.login }
      : null;
  } catch {
    return null;
  }
}

async function run() {
  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log("✅ Connected to MongoDB");

  const gellys = await Gelly.find({ $or: [{ loginName: { $exists: false } }, { loginName: null }] });
  console.log(`Found ${gellys.length} gelly docs without loginName`);

  for (const gelly of gellys) {
    const twitchData = await fetchTwitchUserData(gelly.userId);
    if (twitchData) {
      gelly.displayName = twitchData.displayName;
      gelly.loginName = twitchData.loginName;
      await gelly.save();
      console.log(`✅ Updated ${gelly.userId} → ${gelly.loginName}`);
    } else {
      console.warn(`⚠️ Could not fetch Twitch data for ${gelly.userId}`);
    }
  }

  await mongoose.disconnect();
  console.log("✅ Backfill complete!");
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
=======
// backfill-loginName.js
require("dotenv").config();
const mongoose = require("mongoose");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const Gelly = require("./Gelly.js");

const MONGODB_URI = process.env.MONGODB_URI;
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_APP_ACCESS_TOKEN = process.env.TWITCH_APP_ACCESS_TOKEN;

async function fetchTwitchUserData(userId) {
  try {
    const res = await fetch(`https://api.twitch.tv/helix/users?id=${userId}`, {
      headers: {
        "Client-ID": TWITCH_CLIENT_ID,
        "Authorization": `Bearer ${TWITCH_APP_ACCESS_TOKEN}`
      }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const user = data?.data?.[0];
    return user
      ? { displayName: user.display_name, loginName: user.login }
      : null;
  } catch {
    return null;
  }
}

async function run() {
  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log("✅ Connected to MongoDB");

  const gellys = await Gelly.find({ $or: [{ loginName: { $exists: false } }, { loginName: null }] });
  console.log(`Found ${gellys.length} gelly docs without loginName`);

  for (const gelly of gellys) {
    const twitchData = await fetchTwitchUserData(gelly.userId);
    if (twitchData) {
      gelly.displayName = twitchData.displayName;
      gelly.loginName = twitchData.loginName;
      await gelly.save();
      console.log(`✅ Updated ${gelly.userId} → ${gelly.loginName}`);
    } else {
      console.warn(`⚠️ Could not fetch Twitch data for ${gelly.userId}`);
    }
  }

  await mongoose.disconnect();
  console.log("✅ Backfill complete!");
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
>>>>>>> 42ef2ca755056ceba5a0a12e197b16a2ddcb598b
