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
  username: { type: String, lowercase: true, trim: true, minlength: 3, maxlength: 24, match: /^[a-z0-9_]+$/, unique: true, sparse: true },
  password: { type: String, required: true },
  bio: {
    type: String,
    trim: true,
    maxlength: 2000,
    default: '',
    validate: {
      validator: (value) => !value || value.trim().split(/\s+/).length <= 40,
      message: 'Bio cannot exceed 40 words.'
    }
  },
  hashtags: [{ type: String, trim: true, lowercase: true }],
  links: { type: [linkSchema], validate: (value) => value.length <= 4 },
  profilePicture: { type: String, default: '' },
  bannerImage: { type: String, default: '' },
  profileViews: { type: Number, default: 0 },
  privacy: { type: String, enum: ['public', 'followers'], default: 'public' },
  inactivityLogoutDays: { type: Number, enum: [0, 7, 30, 90], default: 0 },
  notificationPreferences: {
    likes: { type: Boolean, default: true },
    comments: { type: Boolean, default: true },
    mentionsOnly: { type: Boolean, default: false },
    follows: { type: Boolean, default: true },
    messages: { type: Boolean, default: true },
    security: { type: Boolean, default: true },
    emailNewsletter: { type: Boolean, default: true },
    emailUnreadSummary: { type: Boolean, default: true }
  },
  theme: { type: String, enum: ['default', 'light', 'dark', 'violet', 'pink'], default: 'default' },
  newsletterSentPosts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Post' }],
  newsletterLastSentAt: Date,
  unreadSummarySentAt: Date,
  // Push is opt-in and off by default -- a user only gets an entry here
  // (and pushNotificationsEnabled flips to true) after they explicitly
  // click "Enable" in Settings and their browser grants permission.
  pushNotificationsEnabled: { type: Boolean, default: false },
  pushSubscriptions: [{
    endpoint: { type: String, required: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true }
    },
    createdAt: { type: Date, default: Date.now }
  }],
  bookmarks: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Post' }],
  blockedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  mutedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  // Message requests: a DM from someone the recipient has never messaged
  // shows in a separate requests inbox instead of the ordinary one, until the
  // recipient accepts (or declines) it. Replying to someone auto-accepts
  // them, so these lists only need to track the explicit decisions.
  acceptedDmFrom: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  declinedDmFrom: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  twoFactorEnabled: { type: Boolean, default: false },
  twoFactorSecret: String,
  recoveryCodes: [recoveryCodeSchema],
  role: { type: String, enum: ['user', 'moderator', 'admin'], default: 'user', index: true },
  moderatorId: { type: String, unique: true, sparse: true, index: true },
  loginAttempts: { type: Number, default: 0 },
  loginLockedUntil: Date,
  // Admin-imposed suspension, kept separate from loginLockedUntil (which is
  // only ever a self-clearing failed-password lockout) so that a handful of
  // wrong password guesses against a suspended account can never shorten
  // or clear a moderator's suspension.
  suspendedUntil: Date,
  suspensionReason: { type: String, trim: true, maxlength: 500, default: '' },
  // A moderator-imposed temporary block on creating new posts/comments -
  // shorter and less severe than a suspension, and distinct from
  // `mutedUsers` below (which is a personal "hide this person's content
  // from me" preference, not a moderation action).
  postingRestrictedUntil: Date,
  postingRestrictionReason: { type: String, trim: true, maxlength: 500, default: '' },
  // Most-recent-first, capped at 20 by the $slice in webController.search.
  searchHistory: [{
    query: { type: String, trim: true, maxlength: 200 },
    searchedAt: { type: Date, default: Date.now }
  }],
  // Lightweight post-open log used only to personalize the feed (what this
  // person actually stops to read, not just what they like/comment on).
  // Most-recent-first, capped at 60 by the $slice in interactionController.
  recentViews: [{
    post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' },
    viewedAt: { type: Date, default: Date.now }
  }],
  warnings: [{
    reason: { type: String, trim: true, maxlength: 500 },
    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now }
  }],
  twoFactorAttempts: { type: Number, default: 0 },
  twoFactorLockedUntil: Date,
  isVerified: { type: Boolean, default: false },
  following: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  joinedCommunities: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Community' }],
  wavesBalance: { type: Number, default: 0, min: 0 },
  adFreeUntil: { type: Date, default: null },
  wavesTotalEarned: { type: Number, default: 0, min: 0 },
  wavesTotalSpent: { type: Number, default: 0, min: 0 },
  wavesSuspendedUntil: Date,
  wavesSuspensionReason: { type: String, trim: true, maxlength: 500, default: '' },
  verificationCode: String,
  verificationExpires: Date,
  resetToken: String,
  resetExpires: Date,
  dataDownloadRequestedAt: Date
}, { timestamps: true });

// Feed ranking counts followers ("who follows this author") from this field.
userSchema.index({ following: 1 });
userSchema.index({ isVerified: 1, createdAt: -1 });

module.exports = mongoose.model('User', userSchema);
