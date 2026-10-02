const mongoose = require('mongoose');

const postSchema = new mongoose.Schema({
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  coAuthors: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  community: { type: mongoose.Schema.Types.ObjectId, ref: 'Community' },
  quest: { type: mongoose.Schema.Types.ObjectId, ref: 'Quest' },
  questTitle: { type: String, trim: true, maxlength: 80, default: '' },
  body: {
    type: String,
    trim: true,
    validate: {
      validator(value) { return Boolean(this.replyTo) || !value || value.length <= 4000; },
      message: 'Post body cannot exceed 4000 characters.'
    }
  },
  contentWarning: { type: String, trim: true, maxlength: 120, default: '' },
  hashtags: [{ type: String, trim: true, lowercase: true }],
  type: { type: String, enum: ['post', 'article', 'poll'], default: 'post' },
  status: { type: String, enum: ['draft', 'scheduled', 'published', 'pending', 'rejected'], default: 'published' },
  scheduledAt: Date,
  media: [{
    url: { type: String, required: true },
    kind: { type: String, enum: ['image', 'video', 'audio'], default: 'image' },
    alt: String,
    caption: String,
    transcript: String,
    storageKey: String,
    thumbnailUrl: String,
    // Pixel size, stored for images so the feed can reserve the correct
    // aspect ratio. Videos report theirs from the browser once loaded.
    width: Number,
    height: Number
  }],
  poll: {
    question: { type: String, trim: true, maxlength: 200 },
    options: [{
      label: { type: String, trim: true, maxlength: 80 },
      votes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
    }]
  },
  quotedPost: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' },
  replyTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' },
  linkPreview: {
    url: String,
    title: String,
    description: String,
    image: String,
    siteName: String
  },
  reactions: {
    celebrate: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    insightful: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    support: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    funny: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
  },
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  commentsCount: { type: Number, default: 0 },
  viewsCount: { type: Number, default: 0 },
  sharesCount: { type: Number, default: 0 },
  moderationScore: { type: Number, default: 0, index: true },
  moderationStatus: { type: String, enum: ['unreviewed', 'good', 'needs-review', 'reported'], default: 'unreviewed', index: true },
  // Which moderators have already looked at this post in the moderation
  // feed - lets a moderator's queue skip what they've personally already
  // reviewed, and lets everyone's queue skip a post once enough distinct
  // moderators have weighed in (see SiteSetting.postReviewThreshold).
  moderatorReviews: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
}, { timestamps: true });

postSchema.index({ status: 1, createdAt: -1 });
postSchema.index({ status: 1, community: 1, createdAt: -1 });
postSchema.index({ status: 1, type: 1, createdAt: -1 });
postSchema.index({ author: 1, status: 1, createdAt: -1 });
// Feed ranking: interest lookups by hashtag and "posts this person liked".
postSchema.index({ hashtags: 1, status: 1, createdAt: -1 });
postSchema.index({ likes: 1, createdAt: -1 });

module.exports = mongoose.model('Post', postSchema);
