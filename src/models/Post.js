const mongoose = require('mongoose');

const postSchema = new mongoose.Schema({
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  community: { type: mongoose.Schema.Types.ObjectId, ref: 'Community' },
  body: { type: String, trim: true, maxlength: 4000 },
  hashtags: [{ type: String, trim: true, lowercase: true }],
  type: { type: String, enum: ['post', 'article', 'poll'], default: 'post' },
  status: { type: String, enum: ['draft', 'scheduled', 'published', 'pending', 'rejected'], default: 'published' },
  scheduledAt: Date,
  media: [{
    url: { type: String, required: true },
    kind: { type: String, enum: ['image', 'video', 'audio'], default: 'image' },
    alt: String,
    storageKey: String,
    thumbnailUrl: String
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
  moderationStatus: { type: String, enum: ['unreviewed', 'good', 'needs-review', 'reported'], default: 'unreviewed', index: true }
}, { timestamps: true });

postSchema.index({ status: 1, createdAt: -1 });
postSchema.index({ status: 1, community: 1, createdAt: -1 });
postSchema.index({ status: 1, type: 1, createdAt: -1 });
postSchema.index({ author: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('Post', postSchema);
