// backfill-loginName.js
require("dotenv").config();
const mongoose = require("mongoose");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

// 👉 If your model lives at server/models/Gelly.js, use that path:
const Gelly = require("./server/Gelly.js"); // <- change to "./Gelly.js" if your file is there

const MONGODB_URI           = process.env.MONGODB_URI;
const TWITCH_CLIENT_ID      = process.env.TWITCH_CLIENT_ID;
const TWITCH_APP_ACCESS_TOKEN = process.env.TWITCH_APP_ACCESS_TOKEN;

if (!MONGODB_URI) throw new Error("Missing MONGODB_URI");
if (!TWITCH_CLIENT_ID || !TWITCH_APP_ACCESS_TOKEN) {
  console.warn("⚠️ Missing TWITCH_CLIENT_ID or TWITCH_APP_ACCESS_TOKEN — Helix calls will fail.");
}

const PLACEHOLDERS = new Set(["guest", "unknown", "", null, undefined]);

// Normalize: strip opaque prefix "U" and return real id if possible.
function realIdFrom(userId) {
  if (!userId) return null;
  const s = String(userId);
  if (s.startsWith("guest-")) return null;          // skip synthetic guest docs
  if (s.startsWith("U")) return s.slice(1);         // opaque -> real-ish
  return s;
}

async function helixGetUsersByIds(idBatch) {
  if (!idBatch.length) return new Map();
  const params = new URLSearchParams();
  idBatch.forEach((id) => params.append("id", id));
  const url = `https://api.twitch.tv/helix/users?${params.toString()}`;

  const res = await fetch(url, {
    headers: {
      "Client-ID": TWITCH_CLIENT_ID,
      "Authorization": `Bearer ${TWITCH_APP_ACCESS_TOKEN}`,
      "Accept": "application/json",
    },
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error(`Helix auth error ${res.status}. Refresh TWITCH_APP_ACCESS_TOKEN.`);
  }
  if (res.status === 429) {
    // Very simple backoff
    console.warn("⏳ Rate limited by Helix (429). Backing off 2s…");
    await new Promise(r => setTimeout(r, 2000));
    return helixGetUsersByIds(idBatch);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Helix error ${res.status}: ${text}`);
  }

  const data = await res.json().catch(() => ({ data: [] }));
  const out = new Map();
  for (const u of data.data || []) {
    out.set(String(u.id), { displayName: u.display_name, loginName: (u.login || "").toLowerCase() });
  }
  return out;
}

function needsBackfill(doc) {
  const ln = doc.loginName;
  if (!ln || PLACEHOLDERS.has(String(ln).toLowerCase())) return true;
  // enforce lowercase for SE
  if (ln !== String(ln).toLowerCase()) return true;
  return false;
}

async function run() {
  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log("✅ Connected to MongoDB");

  // Only candidates that plausibly map to real Twitch users
  const candidates = await Gelly.find({
    $or: [
      { loginName: { $exists: false } },
      { loginName: null },
      { loginName: "" },
      { loginName: "guest" },
      { loginName: "unknown" },
    ],
  }).lean();

  // Include docs with mixed-case loginName to normalize → lowercase
  const mixedCase = await Gelly.find({
    loginName: { $exists: true, $ne: null },
  }).lean();

  const toProcess = [];
  for (const doc of [...candidates, ...mixedCase]) {
    if (!needsBackfill(doc)) continue;
    const rid = realIdFrom(doc.userId);
    if (!rid) continue; // skip guests/opaque-only ids
    toProcess.push({ _id: doc._id, userId: doc.userId, realId: rid });
  }

  // De-dup by realId
  const uniqueRealIds = [...new Set(toProcess.map(d => d.realId))];
  console.log(`🔎 Backfilling ${toProcess.length} docs across ${uniqueRealIds.length} unique Twitch IDs…`);

  let updated = 0;
  const BATCH = 100;
  for (let i = 0; i < uniqueRealIds.length; i += BATCH) {
    const batchIds = uniqueRealIds.slice(i, i + BATCH);
    console.log(`→ Helix lookup ${i + 1}-${Math.min(i + BATCH, uniqueRealIds.length)} of ${uniqueRealIds.length}`);
    let map;
    try {
      map = await helixGetUsersByIds(batchIds);
    } catch (e) {
      console.error("Helix batch failed:", e.message || e);
      continue;
    }

    // Apply to all docs that share these realIds (handles both real and 'U' variants later if present)
    const targets = toProcess.filter(d => map.has(d.realId));
    const ops = [];
    for (const t of targets) {
      const user = map.get(t.realId);
      if (!user || !user.loginName) continue;
      ops.push({
        updateOne: {
          filter: { _id: t._id },
          update: {
            $set: {
              displayName: user.displayName || "Viewer",
              loginName: user.loginName.toLowerCase(),
            },
          },
        },
      });
    }

    if (ops.length) {
      const res = await Gelly.bulkWrite(ops, { ordered: false });
      updated += (res.modifiedCount || 0) + (res.upsertedCount || 0);
      console.log(`   ✓ updated ${updated} total so far`);
    }
  }

  console.log(`🎉 Done. Updated ${updated} documents.`);
  await mongoose.disconnect();
  console.log("✅ Backfill complete!");
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
