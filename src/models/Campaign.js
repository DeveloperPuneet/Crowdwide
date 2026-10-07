const mongoose = require('mongoose');

const campaignSchema = new mongoose.Schema({
  advertiser: { type: mongoose.Schema.Types.ObjectId, ref: 'Advertiser', required: true, index: true },
  title: { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, trim: true, maxlength: 2000, default: '' },
  status: {
    type: String,
    enum: ['draft', 'submitted', 'approved', 'rejected', 'active', 'paused', 'suspended', 'cancelled', 'completed'],
    default: 'draft',
    index: true
  },
  isWavesFunded: { type: Boolean, default: true },
  fundingStatus: { type: String, enum: ['unfunded', 'funded', 'partially-refunded', 'refunded'], default: 'unfunded', index: true },
  fundingUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  totalBudget: { type: Number, default: 0, min: 0 },
  dailyBudget: { type: Number, default: 0, min: 0 },
  dailyBudgetSpent: { type: Number, default: 0, min: 0 },
  dailyBudgetDate: Date,
  remainingBudget: { type: Number, default: 0, min: 0 },
  startDate: Date,
  endDate: Date,
  targetCommunities: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Community' }],
  impressions: { type: Number, default: 0 },
  clicks: { type: Number, default: 0 },
  ctr: { type: Number, default: 0 },
  wavesSpent: { type: Number, default: 0 },
  refundedBudget: { type: Number, default: 0, min: 0 },
  rejectionReason: { type: String, trim: true, maxlength: 500, default: '' },
  notes: { type: String, trim: true, maxlength: 2000, default: '' },
  reviewedAt: Date,
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  moderatorReview: {
    status: { type: String, enum: ['pending', 'cleared', 'flagged'], default: 'pending' },
    reason: { type: String, trim: true, maxlength: 500, default: '' },
    flaggedCategory: {
      type: String,
      enum: ['', 'adult-18-plus', 'sexual-content', 'gambling-betting', 'pornography', 'other-inappropriate'],
      default: ''
    },
    policyChecks: [{
      type: String,
      enum: ['adult-18-plus', 'sexual-content', 'gambling-betting', 'pornography', 'other-inappropriate']
    }],
    reviewedAt: Date,
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  approvedAt: Date,
  pausedAt: Date,
  suspendedAt: Date,
  suspendedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  suspensionReason: { type: String, trim: true, maxlength: 500, default: '' },
  cancelledAt: Date,
  moderationHistory: [{
    status: { type: String, enum: ['draft', 'submitted', 'approved', 'rejected', 'active', 'paused', 'suspended', 'cancelled', 'completed', 'moderator-cleared', 'moderator-flagged'], required: true },
    reason: { type: String, trim: true, maxlength: 500, default: '' },
    createdAt: { type: Date, default: Date.now },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  }],
  createdByAdmin: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('Campaign', campaignSchema);
