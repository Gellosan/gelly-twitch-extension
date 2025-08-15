// ===== Gelly Model =====
const mongoose = require("mongoose");

const GellySchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },

  displayName: String,

  // Lowercase Twitch login for StreamElements lookups
  loginName: { type: String, lowercase: true, trim: true, index: true },

  energy: { type: Number, default: 50 },
  mood: { type: Number, default: 30 },
  cleanliness: { type: Number, default: 30 },

  stage: { type: String, default: "egg" },
  color: { type: String, default: "blue" },

  // Legacy/local points (SE points are fetched separately)
  points: { type: Number, default: 0 },

  // Care-score fields used by the server-side algorithm
  careMomentum: { type: Number, default: 0 },
  careMomentumUpdatedAt: { type: Date, default: null },
  careScore: { type: Number, default: 0 },

  lastUpdated: { type: Date, default: Date.now },

  // Cooldowns: must be a real Map so .set/.get work
  lastActionTimes: { type: Map, of: Date, default: () => new Map() },

  // Needed by store/equip endpoints
  inventory: {
    type: [
      {
        itemId: { type: String, required: true },
        name: { type: String, default: "" },
        type: { type: String, default: "accessory" },
        equipped: { type: Boolean, default: false },
      },
    ],
    default: [],
  },
});

// --- Methods ---
GellySchema.methods.applyDecay = function () {
  const now = Date.now();
  const hoursSince = (now - this.lastUpdated.getTime()) / (1000 * 60 * 60);

  const decayRate = 5;
  const MAX_STAT = 500;
  const MIN_STAT = 0;

  this.energy = Math.min(MAX_STAT, Math.max(MIN_STAT, this.energy - decayRate * hoursSince));
  this.mood = Math.min(MAX_STAT, Math.max(MIN_STAT, this.mood - decayRate * hoursSince));
  this.cleanliness = Math.min(MAX_STAT, Math.max(MIN_STAT, this.cleanliness - decayRate * hoursSince));

  this.lastUpdated = new Date();
};

GellySchema.methods.checkGrowth = function () {
  if (this.stage === "egg" && this.energy >= 300) {
    this.stage = "blob";
  }
  if (this.stage === "blob" && this.mood >= 300 && this.cleanliness >= 300) {
    this.stage = "gelly";
  }
};

GellySchema.methods.updateStats = function (action) {
  const MAX_STAT = 500;
  let success = false;

  switch (action) {
    case "feed":
      this.energy = Math.min(MAX_STAT, this.energy + 20);
      success = true;
      break;
    case "play":
      this.mood = Math.min(MAX_STAT, this.mood + 20);
      success = true;
      break;
    case "clean":
      this.cleanliness = Math.min(MAX_STAT, this.cleanliness + 20);
      success = true;
      break;
    default:
      return { success: false, message: "Unknown action" };
  }

  if (success) {
    // Ensure it's a Map before using .set()
    if (!(this.lastActionTimes instanceof Map)) {
      const init = this.lastActionTimes && typeof this.lastActionTimes === "object"
        ? Object.entries(this.lastActionTimes)
        : [];
      this.lastActionTimes = new Map(init);
    }
    this.lastActionTimes.set(action, new Date());
    this.checkGrowth();
  }

  return { success };
};

module.exports = mongoose.models.Gelly || mongoose.model("Gelly", GellySchema);
