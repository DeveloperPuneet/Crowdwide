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
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

siteSettingSchema.statics.getSingleton = async function () {
  let doc = await this.findOne({ key: 'singleton' });
  if (!doc) doc = await this.create({ key: 'singleton' });
  return doc;
};

module.exports = mongoose.model('SiteSetting', siteSettingSchema);
