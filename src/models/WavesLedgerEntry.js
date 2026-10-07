const mongoose = require('mongoose');

const wavesLedgerEntrySchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  relatedUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  amount: { type: Number, required: true },
  balanceAfter: { type: Number, default: 0 },
  type: {
    type: String,
    enum: ['earn', 'spend', 'transfer-in', 'transfer-out', 'campaign', 'adjustment', 'refund'],
    default: 'earn',
    index: true
  },
  status: { type: String, enum: ['pending', 'posted', 'reversed'], default: 'posted' },
  description: { type: String, trim: true, maxlength: 200, default: '' },
  reason: { type: String, trim: true, maxlength: 500, default: '' },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  referenceType: { type: String, trim: true, maxlength: 40, default: '' },
  referenceId: { type: mongoose.Schema.Types.ObjectId, default: null }
}, { timestamps: true });

module.exports = mongoose.model('WavesLedgerEntry', wavesLedgerEntrySchema);
