const mongoose = require('mongoose');

// An address the bot guard has blocked. MongoDB removes the row itself once
// expiresAt passes (TTL index), so a block lasts exactly as long as it says.
const blockedIpSchema = new mongoose.Schema({
  ip: { type: String, required: true, unique: true, index: true },
  reason: { type: String, maxlength: 200, default: '' },
  hits: { type: Number, default: 0 },
  lastPath: { type: String, maxlength: 200, default: '' },
  userAgent: { type: String, maxlength: 300, default: '' },
  blockedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true }
}, { timestamps: true });

blockedIpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('BlockedIp', blockedIpSchema);
