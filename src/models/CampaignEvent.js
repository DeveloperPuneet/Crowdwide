const mongoose = require('mongoose');

const campaignEventSchema = new mongoose.Schema({
  campaign: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
  community: { type: mongoose.Schema.Types.ObjectId, ref: 'Community', required: true, index: true },
  viewer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  eventType: { type: String, enum: ['impression', 'click'], required: true },
  eventToken: { type: String, required: true, maxlength: 36 },
  createdAt: { type: Date, default: Date.now, index: true }
});

campaignEventSchema.index({ campaign: 1, community: 1, eventType: 1, eventToken: 1 }, { unique: true });
campaignEventSchema.index({ campaign: 1, community: 1, createdAt: -1 });
campaignEventSchema.index({ campaign: 1, createdAt: -1 });

module.exports = mongoose.model('CampaignEvent', campaignEventSchema);
