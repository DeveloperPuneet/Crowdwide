const mongoose = require('mongoose');

const questSchema = new mongoose.Schema({
  community: { type: mongoose.Schema.Types.ObjectId, ref: 'Community', required: true, index: true },
  creator: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, trim: true, required: true, maxlength: 80 },
  description: { type: String, trim: true, maxlength: 260, default: '' },
  goal: { type: String, trim: true, maxlength: 150, default: '' },
  reward: { type: String, trim: true, maxlength: 120, default: '' },
  status: { type: String, enum: ['open', 'active', 'completed', 'ended', 'archived'], default: 'open', index: true },
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  completedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  winner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  rewarded: { type: Boolean, default: false },
  endedAt: { type: Date },
  rewardSentAt: { type: Date }
}, { timestamps: true });

questSchema.index({ community: 1, createdAt: -1 });

module.exports = mongoose.model('Quest', questSchema);
