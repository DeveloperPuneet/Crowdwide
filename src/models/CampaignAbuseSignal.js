const mongoose = require('mongoose');

const campaignAbuseSignalSchema = new mongoose.Schema({
  signalKey: { type: String, required: true, unique: true, maxlength: 300 },
  campaign: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
  community: { type: mongoose.Schema.Types.ObjectId, ref: 'Community', required: true, index: true },
  viewer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  eventType: { type: String, enum: ['impression', 'click', 'bot-activity'], required: true },
  reason: { type: String, trim: true, maxlength: 200, required: true },
  attempts: { type: Number, default: 1, min: 1 },
  firstSeenAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now },
  status: { type: String, enum: ['open', 'reviewed'], default: 'open', index: true },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedAt: Date,
  reviewNote: { type: String, trim: true, maxlength: 500, default: '' }
}, { timestamps: true });

campaignAbuseSignalSchema.index({ status: 1, lastSeenAt: -1 });

module.exports = mongoose.model('CampaignAbuseSignal', campaignAbuseSignalSchema);
