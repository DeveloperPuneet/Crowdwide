const mongoose = require('mongoose');

// An approved partner shown on the public site. Created automatically (hidden) when an admin
// approves an application, or added by hand. The admin adds/edits the logo, name and website
// in Admin → Partner logos; every public placement reads from this collection.
const partnerSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  websiteUrl: { type: String, required: true, trim: true, maxlength: 300 },
  websiteHost: { type: String, trim: true, lowercase: true, maxlength: 255, index: true, default: '' },
  logoUrl: { type: String, trim: true, maxlength: 500, default: '' },
  description: { type: String, trim: true, maxlength: 200, default: '' },
  displayOrder: { type: Number, default: 100 },
  isVisible: { type: Boolean, default: false, index: true },
  showOnLanding: { type: Boolean, default: true },
  application: { type: mongoose.Schema.Types.ObjectId, ref: 'PartnershipApplication', default: null },
  partnerSince: { type: Date, default: Date.now },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

partnerSchema.index({ isVisible: 1, displayOrder: 1, name: 1 });

module.exports = mongoose.model('Partner', partnerSchema);
