const mongoose = require('mongoose');

const moderationActionSchema = new mongoose.Schema({
  moderator: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  action: { type: String, enum: ['delete-post', 'edit-post', 'suspend-user', 'unsuspend-user', 'warn-user', 'edit-community', 'resolve-report', 'rate-good-post', 'rate-bad-post', 'report-post'], required: true },
  targetType: { type: String, enum: ['post', 'user', 'community', 'report'], required: true },
  target: { type: mongoose.Schema.Types.ObjectId, required: true },
  payload: { type: mongoose.Schema.Types.Mixed },
  reason: { type: String, trim: true, maxlength: 1000, required: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: Date,
  reviewNote: String
}, { timestamps: true });

module.exports = mongoose.model('ModerationAction', moderationActionSchema);
