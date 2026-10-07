const mongoose = require('mongoose');

const advertiserSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  businessName: { type: String, required: true, trim: true, maxlength: 120 },
  website: { type: String, trim: true, maxlength: 300, default: '' },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'suspended'],
    default: 'pending',
    index: true
  },
  isVerified: { type: Boolean, default: false },
  rejectionReason: { type: String, trim: true, maxlength: 500, default: '' },
  notes: { type: String, trim: true, maxlength: 2000, default: '' },
  termsAcceptedAt: Date,
  termsVersion: { type: String, trim: true, maxlength: 40, default: '' },
  verifiedAt: Date,
  approvedAt: Date,
  suspendedAt: Date,
  reviewedAt: Date,
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  moderatorReview: {
    status: { type: String, enum: ['pending', 'cleared', 'flagged'], default: 'pending' },
    reason: { type: String, trim: true, maxlength: 500, default: '' },
    reviewedAt: Date,
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  moderationHistory: [{
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'suspended'], required: true },
    reason: { type: String, trim: true, maxlength: 500, default: '' },
    createdAt: { type: Date, default: Date.now },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  }],
  createdByAdmin: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('Advertiser', advertiserSchema);
