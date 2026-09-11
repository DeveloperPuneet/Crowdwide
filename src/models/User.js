const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  bio: { type: String, trim: true, maxlength: 280, default: '' },
  profilePicture: { type: String, default: '' },
  privacy: { type: String, enum: ['public', 'followers'], default: 'public' },
  inactivityLogoutDays: { type: Number, enum: [0, 7, 30, 90], default: 0 },
  bookmarks: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Post' }],
  twoFactorEnabled: { type: Boolean, default: false },
  twoFactorSecret: String,
  loginAttempts: { type: Number, default: 0 },
  loginLockedUntil: Date,
  isVerified: { type: Boolean, default: false },
  following: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  joinedCommunities: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Community' }],
  verificationCode: String,
  verificationExpires: Date,
  resetToken: String,
  resetExpires: Date,
  dataDownloadRequestedAt: Date
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
