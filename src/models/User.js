const mongoose = require('mongoose');

const linkSchema = new mongoose.Schema({
  label: { type: String, trim: true, maxlength: 40, required: true },
  url: { type: String, trim: true, maxlength: 300, required: true }
}, { _id: false });

const recoveryCodeSchema = new mongoose.Schema({
  codeHash: { type: String, required: true },
  usedAt: Date
}, { _id: false });

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  bio: { type: String, trim: true, maxlength: 280, default: '' },
  hashtags: [{ type: String, trim: true, lowercase: true }],
  links: { type: [linkSchema], validate: (value) => value.length <= 4 },
  profilePicture: { type: String, default: '' },
  bannerImage: { type: String, default: '' },
  privacy: { type: String, enum: ['public', 'followers'], default: 'public' },
  inactivityLogoutDays: { type: Number, enum: [0, 7, 30, 90], default: 0 },
  notificationPreferences: {
    likes: { type: Boolean, default: true },
    comments: { type: Boolean, default: true },
    follows: { type: Boolean, default: true },
    security: { type: Boolean, default: true }
  },
  bookmarks: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Post' }],
  blockedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  mutedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  twoFactorEnabled: { type: Boolean, default: false },
  twoFactorSecret: String,
  recoveryCodes: [recoveryCodeSchema],
  role: { type: String, enum: ['user', 'moderator', 'admin'], default: 'user', index: true },
  moderatorId: { type: String, unique: true, sparse: true, index: true },
  loginAttempts: { type: Number, default: 0 },
  loginLockedUntil: Date,
  twoFactorAttempts: { type: Number, default: 0 },
  twoFactorLockedUntil: Date,
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
