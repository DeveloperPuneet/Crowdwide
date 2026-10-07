const mongoose = require('mongoose');

const wavesRewardRangeSchema = new mongoose.Schema({
  minimum: { type: Number, min: 0, max: 10000, default: 1 },
  maximum: { type: Number, min: 0, max: 10000, default: 3 }
}, { _id: false });

// Singleton document (there is only ever one row) holding the site-wide
// controls the admin panel exposes: identity, registration, and a
// maintenance/announcement banner shown to everyone.
const siteSettingSchema = new mongoose.Schema({
  key: { type: String, default: 'singleton', unique: true },
  siteName: { type: String, trim: true, maxlength: 60, default: 'Crowdwide' },
  tagline: { type: String, trim: true, maxlength: 160, default: 'A fair chance at discovery.' },
  registrationOpen: { type: Boolean, default: true },
  maintenanceMode: { type: Boolean, default: false },
  maintenanceMessage: { type: String, trim: true, maxlength: 300, default: '' },
  announcement: { type: String, trim: true, maxlength: 300, default: '' },
  postApprovalDefault: { type: Boolean, default: false },
  // Content limits - configurable so the admin panel controls them instead
  // of them being buried as constants in controller code.
  postWordLimit: { type: Number, default: 60, min: 10, max: 2000 },
  articleWordLimit: { type: Number, default: 300, min: 50, max: 20000 },
  // Default length of a "Suspend" action when the admin does not pick a
  // custom end date for that user.
  suspensionDefaultDays: { type: Number, default: 365, min: 1, max: 3650 },
  // Once this many distinct moderators have looked at a post, it drops out
  // of everyone's moderation queue - no point re-showing something 5+
  // people already judged.
  postReviewThreshold: { type: Number, default: 5, min: 1, max: 50 },
  monetizationMinimumPosts: { type: Number, default: 20, min: 0, max: 10000 },
  monetizationMinimumLikes: { type: Number, default: 30, min: 0, max: 100000 },
  monetizationMinimumComments: { type: Number, default: 10, min: 0, max: 100000 },
  monetizationMinimumCommunityAgeDays: { type: Number, default: 30, min: 0, max: 3650 },
  monetizationRecentActivityDays: { type: Number, default: 30, min: 1, max: 365 },
  wavesPostReward: { type: wavesRewardRangeSchema, default: () => ({}) },
  wavesCommentReward: { type: wavesRewardRangeSchema, default: () => ({}) },
  wavesLikeReward: { type: wavesRewardRangeSchema, default: () => ({ minimum: 0.1, maximum: 1 }) },
  wavesReceivedCommentReward: { type: wavesRewardRangeSchema, default: () => ({ minimum: 0.1, maximum: 1 }) },
  wavesCommunityJoinReward: { type: wavesRewardRangeSchema, default: () => ({ minimum: 1, maximum: 2 }) },
  wavesCommunityCreateReward: { type: wavesRewardRangeSchema, default: () => ({ minimum: 2, maximum: 5 }) },
  wavesQuestCompletionReward: { type: wavesRewardRangeSchema, default: () => ({ minimum: 1, maximum: 5 }) },
  wavesDailyEarningLimit: { type: Number, default: 20, min: 0, max: 100000 },
  wavesMaxTransferAmount: { type: Number, default: 100, min: 0, max: 1000000 },
  wavesDailyTransferLimit: { type: Number, default: 500, min: 0, max: 10000000 },
  postPromotionEnabled: { type: Boolean, default: true },
  postPromotionWavesCost: { type: Number, default: 25, min: 1, max: 10000 },
  postPromotionDurationHours: { type: Number, default: 24, min: 1, max: 168 },
  communityPromotionEnabled: { type: Boolean, default: true },
  communityPromotionWavesCost: { type: Number, default: 50, min: 1, max: 10000 },
  communityPromotionDurationHours: { type: Number, default: 48, min: 1, max: 168 },
  advertisingMinimumCampaignBudget: { type: Number, default: 25, min: 1, max: 1000000 },
  advertisingCostPerImpression: { type: Number, default: 0.1, min: 0, max: 10000 },
  advertisingCostPerClick: { type: Number, default: 1, min: 0, max: 10000 },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

siteSettingSchema.statics.getSingleton = async function () {
  return this.findOneAndUpdate(
    { key: 'singleton' },
    { $setOnInsert: { key: 'singleton' } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
};

module.exports = mongoose.model('SiteSetting', siteSettingSchema);
