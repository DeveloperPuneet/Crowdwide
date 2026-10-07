const mongoose = require('mongoose');

const joinRequestSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now }
}, { _id: false });

const memberRoleSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  role: { type: String, enum: ['member', 'moderator'], default: 'member' }
}, { _id: false });

const monetizationApplicationSchema = new mongoose.Schema({
  applicantName: { type: String, trim: true, default: '' },
  contactEmail: { type: String, trim: true, default: '' },
  website: { type: String, trim: true, default: '' },
  businessName: { type: String, trim: true, default: '' },
  country: { type: String, trim: true, default: '' },
  audience: { type: String, trim: true, default: '' },
  goals: { type: String, trim: true, default: '' },
  notes: { type: String, trim: true, default: '' },
  rejectionReason: { type: String, trim: true, default: '' },
  appealMessage: { type: String, trim: true, maxlength: 1000, default: '' },
  appealStatus: { type: String, enum: ['', 'pending', 'approved', 'denied'], default: '' },
  appealedAt: Date,
  submittedAt: { type: Date, default: Date.now },
  reviewedAt: Date,
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { _id: false });

const monetizationSettingsSchema = new mongoose.Schema({
  adsEnabled: { type: Boolean, default: false },
  adPlacement: { type: String, enum: ['feed', 'sidebar', 'all', 'none'], default: 'feed' },
  adFrequency: { type: Number, min: 1, max: 10, default: 1 },
  revenueSharePercent: { type: Number, min: 0, max: 100, default: 0 },
  requiresAdminReview: { type: Boolean, default: true }
}, { _id: false });

const monetizationHistoryEntrySchema = new mongoose.Schema({
  status: { type: String, enum: ['pending', 'approved', 'rejected', 'paused', 'none'], required: true },
  action: { type: String, trim: true, default: '' },
  note: { type: String, trim: true, default: '' },
  createdAt: { type: Date, default: Date.now },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { _id: false });

const communitySchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true, trim: true, unique: true },
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
  description: { type: String, required: true, trim: true, maxlength: 280 },
  guidelines: { type: String, trim: true, maxlength: 4000, default: '' },
  category: { type: String, trim: true, lowercase: true, default: 'general' },
  hashtags: [{ type: String, trim: true, lowercase: true }],
  isPrivate: { type: Boolean, default: false },
  inviteCode: { type: String, unique: true, sparse: true, select: false },
  showOnMap: { type: Boolean, default: false },
  locationLabel: { type: String, trim: true, maxlength: 100, default: '' },
  locationLat: { type: Number, min: -90, max: 90 },
  locationLng: { type: Number, min: -180, max: 180 },
  requireApproval: { type: Boolean, default: false },
  membersCount: { type: Number, default: 0 },
  members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  memberRoles: [memberRoleSchema],
  moderators: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  pinnedPosts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Post' }],
  joinRequests: [joinRequestSchema],
  bannedWords: [{ type: String, trim: true, lowercase: true }],
  coverImage: String,
  avatarImage: String,
  monetizationStatus: { type: String, enum: ['none', 'pending', 'approved', 'rejected', 'paused'], default: 'none' },
  isMonetized: { type: Boolean, default: false },
  monetizationApplication: { type: monetizationApplicationSchema, default: () => ({}) },
  monetizationSettings: { type: monetizationSettingsSchema, default: () => ({}) },
  monetizationModeratorReview: {
    status: { type: String, enum: ['pending', 'cleared', 'flagged'], default: 'pending' },
    reason: { type: String, trim: true, maxlength: 500, default: '' },
    reviewedAt: Date,
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  monetizationHistory: [monetizationHistoryEntrySchema],
  monetizationApprovedAt: Date,
  monetizationUpdatedAt: Date,
  promotionStatus: { type: String, enum: ['disabled', 'pending', 'active', 'expired'], default: 'disabled', index: true },
  promotionStartedAt: Date,
  promotionUntil: Date,
  promotionWavesCost: { type: Number, min: 0 },
  promotionPurchaseKey: { type: String, trim: true, maxlength: 100 }
}, { timestamps: true });

communitySchema.index({ isPrivate: 1, showOnMap: 1, locationLat: 1, locationLng: 1 });
communitySchema.index({ isPrivate: 1, promotionStatus: 1, promotionUntil: 1 });

module.exports = mongoose.model('Community', communitySchema);
