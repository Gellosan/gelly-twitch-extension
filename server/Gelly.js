// Gelly.js
const mongoose = require("mongoose");

/** Inventory item subdoc */
const InventoryItemSchema = new mongoose.Schema(
  {
    itemId: { type: String, required: true, trim: true },
    name: { type: String, default: "" },
    type: { type: String, default: "accessory" }, // hat | accessory | weapon | …
    equipped: { type: Boolean, default: false },
  },
  { _id: false }
);

const GellySchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true, index: true },

    displayName: { type: String, default: "Guest Viewer" },
    loginName: { type: String, default: "guest" },

    // core stats
    points: { type: Number, default: 0 },
    energy: { type: Number, default: 100 },
    mood: { type: Number, default: 50 },
    cleanliness: { type: Number, default: 50 },

    color: { type: String, default: "blue" },
    stage: { type: String, default: "egg" },

    lastUpdated: { type: Date, default: Date.now },

    // cooldowns: key -> Date
    lastActionTimes: { type: Map, of: Date, default: {} },

    // inventory you’re trying to write to
    inventory: { type: [InventoryItemSchema], default: [] },
  },
  { timestamps: true, minimize: false, strict: true }
);

/** Simple decay — tweak as you like */
GellySchema.methods.applyDecay = function applyDecay() {
  const now = Date.now();
  const then = this.lastUpdated ? this.lastUpdated.getTime() : now;
  const mins = Math.max(0, (now - then) / 60000);
  if (mins > 1) {
    const decay = Math.floor(mins / 5); // every 5 min
    this.energy = Math.max(0, this.energy - decay);
    this.mood = Math.max(0, this.mood - Math.floor(decay / 2));
    this.cleanliness = Math.max(0, this.cleanliness - Math.floor(decay / 3));
    this.lastUpdated = new Date(now);
  }
};

/** Update stats for an action */
GellySchema.methods.updateStats = function updateStats(action) {
  const clamp = (n) => Math.max(0, Math.min(100, n));
  if (action === "feed") {
    this.energy = clamp(this.energy + 15);
    this.mood = clamp(this.mood + 5);
  } else if (action === "play") {
    this.mood = clamp(this.mood + 15);
    this.energy = clamp(this.energy - 5);
  } else if (action === "clean") {
    this.cleanliness = clamp(this.cleanliness + 20);
    this.mood = clamp(this.mood + 3);
  }
  // evolve example
  if (this.stage === "egg" && this.energy >= 80 && this.mood >= 60 && this.cleanliness >= 60) {
    this.stage = "blob";
  } else if (this.stage === "blob" && this.energy >= 90 && this.mood >= 80 && this.cleanliness >= 80) {
    this.stage = "adult";
  }
  this.lastUpdated = new Date();
  return { success: true };
};

module.exports = mongoose.model("Gelly", GellySchema);
