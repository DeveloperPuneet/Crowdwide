const mongoose = require('mongoose');

// A request from an outside organization or website owner to become a Crowdwide partner.
// Submitted from the public /partnerships/apply form and decided by an admin.
const partnershipApplicationSchema = new mongoose.Schema({
  reference: { type: String, required: true, unique: true, index: true },
  organizationName: { type: String, required: true, trim: true, maxlength: 120 },
  organizationType: {
    type: String,
    enum: ['company', 'nonprofit', 'educational', 'community', 'media', 'developer', 'other'],
    default: 'other'
  },
  websiteUrl: { type: String, required: true, trim: true, maxlength: 300 },
  websiteHost: { type: String, required: true, trim: true, lowercase: true, maxlength: 255, index: true },
  logoLink: { type: String, trim: true, maxlength: 500, default: '' },
  country: { type: String, trim: true, maxlength: 80, default: '' },
  contactName: { type: String, required: true, trim: true, maxlength: 100 },
  contactRole: { type: String, trim: true, maxlength: 100, default: '' },
  contactEmail: { type: String, required: true, trim: true, lowercase: true, maxlength: 200, index: true },
  emailMatchesWebsite: { type: Boolean, default: false },
  description: { type: String, required: true, trim: true, maxlength: 1000 },
  collaboration: { type: String, required: true, trim: true, maxlength: 1500 },
  displayUrl: { type: String, trim: true, maxlength: 400, default: '' },
  // Legal attestations recorded at submission (all required on the form).
  termsVersion: { type: String, required: true, maxlength: 40 },
  attestedAt: { type: Date, required: true },
  attestations: {
    authorized: { type: Boolean, default: false },
    accurate: { type: Boolean, default: false },
    ownsAssets: { type: Boolean, default: false },
    acceptsTerms: { type: Boolean, default: false },
    displayConsent: { type: Boolean, default: false },
    lawfulContent: { type: Boolean, default: false }
  },
  ipAddress: { type: String, maxlength: 80, default: '' },
  status: { type: String, enum: ['pending', 'approved', 'rejected', 'ended'], default: 'pending', index: true },
  decisionReason: { type: String, trim: true, maxlength: 500, default: '' },
  reviewedAt: Date,
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  partner: { type: mongoose.Schema.Types.ObjectId, ref: 'Partner', default: null },
  endedAt: Date
}, { timestamps: true });

partnershipApplicationSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('PartnershipApplication', partnershipApplicationSchema);
