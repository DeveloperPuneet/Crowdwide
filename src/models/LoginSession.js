const mongoose = require('mongoose');

const loginSessionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  sessionId: { type: String, required: true, unique: true },
  ipAddress: String,
  userAgent: String,
  lastSeenAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 75 }
});

module.exports = mongoose.model('LoginSession', loginSessionSchema);