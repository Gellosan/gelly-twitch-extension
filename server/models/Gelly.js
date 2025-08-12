// ===== Gelly Model =====
const mongoose = require("mongoose");

// Subdoc for inventory items
const InventoryItemSchema = new mongoose.Schema(
  {
    itemId: { type: String, required: true },
    name: { type: String, default: "" },
    type: { type: String, default: "accessory" }, // hat, accessory, weapon...
    equipped: { type: Boolean, default: false },
  },
  { _id: false }
);

const GellySchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  displayName: String,
  loginName: String, // lowercase Twitch login for StreamElements
  energy: { type: Number, default: 50 },
  mood: { type: Number, default: 30 },
  cleanliness: { type: Number, default: 30 },
  stage: { type: String, default: "egg" },
  color: { type: String, default: "blue" },
  points: { type: Number, default: 0 },
  lastUpdated: { type: Date, default: Date.now },
  lastActionTimes: { type: Map, of: Date, default: {} },

  // Inventory
  inventory: { type: [InventoryItemSchema], default: [] },
});

GellySchema.methods.applyDecay = function () {
  const now = Date.now();
  const hoursSince = (now - this.lastUpdated.getTime()) / (1000 * 60 * 60);
  const decayRate = 5;
  const MAX_STAT = 500;
  const clamp = (v) => Math.min(MAX_STAT, Math.max(0, v));
  this.energy = clamp(this.energy - decayRate * hoursSince);
  this.mood = clamp(this.mood - decayRate * hoursSince);
  this.cleanliness = clamp(this.cleanliness - decayRate * hoursSince);
  this.lastUpdated = new Date();
};

GellySchema.methods.checkGrowth = function () {
  if (this.stage === "egg" && this.energy >= 300) this.stage = "blob";
  if (this.stage === "blob" && this.mood >= 300 && this.cleanliness >= 300) this.stage = "gelly";
};

GellySchema.methods.updateStats = function (action) {
  const MAX_STAT = 500;
  const bump = (v) => Math.min(MAX_STAT, v + 20);
  if (action === "feed") this.energy = bump(this.energy);
  else if (action === "play") this.mood = bump(this.mood);
  else if (action === "clean") this.cleanliness = bump(this.cleanliness);
  else return { success: false, message: "Unknown action" };
  this.lastActionTimes.set(action, new Date());
  this.checkGrowth();
  return { success: true };
};

module.exports = mongoose.models.Gelly || mongoose.model("Gelly", GellySchema);
