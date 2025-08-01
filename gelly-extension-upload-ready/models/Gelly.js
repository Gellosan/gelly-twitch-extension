const mongoose = require("mongoose");

const GellySchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  displayName: String,
  energy: { type: Number, default: 100 },
  mood: { type: Number, default: 50 },
  cleanliness: { type: Number, default: 50 },
  stage: { type: String, default: "egg" },
  color: { type: String, default: "blue" },
  lastUpdated: { type: Date, default: Date.now }
});

// ✅ Prevent OverwriteModelError in development / hot reload
module.exports = mongoose.models.Gelly || mongoose.model("Gelly", GellySchema);

