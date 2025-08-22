// server/models/Gelly.js
const mongoose = require("mongoose");

/** Inventory item subdoc */
const InventoryItemSchema = new mongoose.Schema(
  {
    itemId:   { type: String, required: true, trim: true },
    name:     { type: String, default: "" },
    type:     { type: String, default: "accessory" }, // hat | accessory | weapon | …
    equipped: { type: Boolean, default: false },
  },
  { _id: false }
);

const GellySchema = new mongoose.Schema(
  {
    userId:      { type: String, required: true, unique: true, index: true },

    displayName: { type: String, default: "Guest Viewer" },
    // Lowercased Twitch login for StreamElements lookups
    loginName:   { type: String, default: "guest", lowercase: true, trim: true, index: true },

    // Local points (SE points are fetched via API)
    points:      { type: Number, default: 0 },

    // Core stats (0..100 expected by care-score base calc)
    energy:      { type: Number, default: 100 },
    mood:        { type: Number, default: 50 },
    cleanliness: { type: Number, default: 50 },

    color:       { type: String, default: "blue" },
    stage:       { type: String, default: "egg" }, // egg -> blob -> gelly

    lastUpdated: { type: Date, default: Date.now },

    // cooldown map (must be a real Map so .set/.get work)
    lastActionTimes: { type: Map, of: Date, default: () => new Map() },

    // Inventory (required by store/equip endpoints)
    inventory:   { type: [InventoryItemSchema], default: [] },

    // Care-score fields used by server-side algorithm
    careMomentum:          { type: Number, default: 0 },
    careMomentumUpdatedAt: { type: Date, default: null },
    careScore:             { type: Number, default: 0 },
  },
  { timestamps: true, minimize: false, strict: true }
);

// Methods
GellySchema.methods.applyDecay = function () {
  const now = Date.now();
  const then = this.lastUpdated ? this.lastUpdated.getTime() : now;
  const mins = Math.max(0, (now - then) / 60000);
  if (mins > 1) {
    const decay = Math.floor(mins / 15); // every 15 min tick
    this.energy      = Math.max(0, this.energy - decay);
    this.mood        = Math.max(0, this.mood - Math.floor(decay / 2));
    this.cleanliness = Math.max(0, this.cleanliness - Math.floor(decay / 3));
    this.lastUpdated = new Date(now);
  }
};

GellySchema.methods.updateStats = function (action) {
  const clamp = (n) => Math.max(0, Math.min(100, n));

  if (action === "feed") {
    this.energy = clamp(this.energy + 25);
    this.mood   = clamp(this.mood + 5);
  } else if (action === "play") {
    this.mood   = clamp(this.mood + 15);
    this.energy = clamp(this.energy - 5);
  } else if (action === "clean") {
    this.cleanliness = clamp(this.cleanliness + 20);
    this.mood        = clamp(this.mood + 3);
  } else {
    return { success: false, message: "Unknown action" };
  }

  // Stage progression (keep names aligned with extension/server logic)
  if (this.stage === "egg" && this.energy >= 80 && this.mood >= 60 && this.cleanliness >= 60) {
    this.stage = "blob";
  } else if (this.stage === "blob" && this.energy >= 90 && this.mood >= 80 && this.cleanliness >= 80) {
    this.stage = "gelly";
  }

  this.lastUpdated = new Date();
  return { success: true };
};

// ✅ hot-reload/duplicate-import safe export
module.exports = mongoose.models.Gelly || mongoose.model("Gelly", GellySchema);
