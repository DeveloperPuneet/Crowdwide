const mongoose = require('mongoose');

const wavesLedgerEntrySchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  relatedUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  community: { type: mongoose.Schema.Types.ObjectId, ref: 'Community', default: null, index: true },
  amount: { type: Number, required: true },
  balanceAfter: { type: Number, default: 0 },
  type: {
    type: String,
    enum: ['earn', 'spend', 'transfer-in', 'transfer-out', 'campaign', 'adjustment', 'refund'],
    default: 'earn',
    index: true
  },
  status: { type: String, enum: ['pending', 'processing', 'posted', 'reversed'], default: 'posted' },
  description: { type: String, trim: true, maxlength: 200, default: '' },
  reason: { type: String, trim: true, maxlength: 500, default: '' },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  referenceType: { type: String, trim: true, maxlength: 40, default: '' },
  referenceId: { type: mongoose.Schema.Types.ObjectId, default: null },
  rewardKey: { type: String, trim: true, maxlength: 500, unique: true, sparse: true },
  processingUntil: { type: Date, default: null }
}, { timestamps: true });

wavesLedgerEntrySchema.index({ type: 1, status: 1, createdAt: -1, actor: 1 });

module.exports = mongoose.model('WavesLedgerEntry', wavesLedgerEntrySchema);
