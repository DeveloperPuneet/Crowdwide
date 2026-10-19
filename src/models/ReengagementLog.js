const mongoose = require('mongoose');

// One row per come-back reminder sent. Lets the admin see how many were sent
// and how many brought the member back, and caps how many go out per day.
const reengagementLogSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  stage: { type: String, enum: ['question', 'discussion', 'winback', 'welcome-1', 'welcome-2', 'welcome-3', 'welcome-4', 'first-reply'], required: true },
  channels: [{ type: String, enum: ['email', 'push', 'in-app'] }],
  sentAt: { type: Date, default: Date.now },
  returnedAt: Date
}, { versionKey: false });

// Reporting only needs a few months.
reengagementLogSchema.index({ sentAt: 1 }, { expireAfterSeconds: 120 * 24 * 60 * 60 });

module.exports = mongoose.model('ReengagementLog', reengagementLogSchema);
