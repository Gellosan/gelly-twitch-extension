// ===== Gelly Model =====
const mongoose = require("mongoose");

const GellySchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  displayName: String,
  energy: { type: Number, default: 100 }, // Raised caps handled in logic
  mood: { type: Number, default: 50 },
  cleanliness: { type: Number, default: 50 },
  stage: { type: String, default: "egg" },
  color: { type: String, default: "blue" },
  points: { type: Number, default: 0 },
  lastUpdated: { type: Date, default: Date.now },
  lastActionTimes: { type: Map, of: Date, default: {} }
});

GellySchema.methods.applyDecay = function () {
  const now = Date.now();
  const hoursSince = (now - this.lastUpdated.getTime()) / (1000 * 60 * 60);

  // Decay per hour
  const decayRate = 5; 
  this.energy = Math.max(0, this.energy - decayRate * hoursSince);
  this.mood = Math.max(0, this.mood - decayRate * hoursSince);
  this.cleanliness = Math.max(0, this.cleanliness - decayRate * hoursSince);

  this.lastUpdated = new Date();
};

GellySchema.methods.checkGrowth = function () {
  // NEW: Higher thresholds so growth is slow & persistent
  if (this.stage === "egg" && this.energy >= 300) {
    this.stage = "blob";
  }
  if (this.stage === "blob" && this.mood >= 300 && this.cleanliness >= 300) {
    this.stage = "gelly";
  }
};

GellySchema.methods.updateStats = function (action) {
  const MAX_STAT = 500; // Raised cap for slower maxing
  const now = Date.now();

  // 60s cooldown per action type
  const cooldown = 60 * 1000;
  if (this.lastActionTimes.has(action)) {
    const lastTime = this.lastActionTimes.get(action).getTime();
    if (now - lastTime < cooldown) {
      return { success: false, message: `You must wait ${Math.ceil((cooldown - (now - lastTime)) / 1000)}s before doing that again.` };
    }
  }

  switch (action) {
    case "feed":
      this.energy = Math.min(MAX_STAT, this.energy + 20);
      break;
    case "play":
      this.mood = Math.min(MAX_STAT, this.mood + 20);
      break;
    case "clean":
      this.cleanliness = Math.min(MAX_STAT, this.cleanliness + 20);
      break;
    default:
      return { success: false, message: "Unknown action" };
  }

  this.lastActionTimes.set(action, new Date());
  this.checkGrowth();
  return { success: true };
};

module.exports = mongoose.models.Gelly || mongoose.model("Gelly", GellySchema);
