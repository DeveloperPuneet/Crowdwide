const mongoose = require('mongoose');

const campaignSchema = new mongoose.Schema({
  advertiser: { type: mongoose.Schema.Types.ObjectId, ref: 'Advertiser', required: true, index: true },
  title: { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, trim: true, maxlength: 2000, default: '' },
  status: {
    type: String,
    enum: ['draft', 'submitted', 'approved', 'rejected', 'active', 'paused', 'cancelled', 'completed'],
    default: 'draft',
    index: true
  },
  isWavesFunded: { type: Boolean, default: true },
  totalBudget: { type: Number, default: 0, min: 0 },
  dailyBudget: { type: Number, default: 0, min: 0 },
  remainingBudget: { type: Number, default: 0, min: 0 },
  startDate: Date,
  endDate: Date,
  targetCommunities: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Community' }],
  impressions: { type: Number, default: 0 },
  clicks: { type: Number, default: 0 },
  ctr: { type: Number, default: 0 },
  wavesSpent: { type: Number, default: 0 },
  rejectionReason: { type: String, trim: true, maxlength: 500, default: '' },
  notes: { type: String, trim: true, maxlength: 2000, default: '' },
  reviewedAt: Date,
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt: Date,
  pausedAt: Date,
  cancelledAt: Date,
  moderationHistory: [{
    status: { type: String, enum: ['draft', 'submitted', 'approved', 'rejected', 'active', 'paused', 'cancelled', 'completed'], required: true },
    reason: { type: String, trim: true, maxlength: 500, default: '' },
    createdAt: { type: Date, default: Date.now },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  }],
  createdByAdmin: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('Campaign', campaignSchema);
