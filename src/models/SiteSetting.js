const mongoose = require('mongoose');

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
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

siteSettingSchema.statics.getSingleton = async function () {
  let doc = await this.findOne({ key: 'singleton' });
  if (!doc) doc = await this.create({ key: 'singleton' });
  return doc;
};

module.exports = mongoose.model('SiteSetting', siteSettingSchema);
