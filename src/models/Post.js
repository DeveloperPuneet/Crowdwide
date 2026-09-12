const mongoose = require('mongoose');

const postSchema = new mongoose.Schema({
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  community: { type: mongoose.Schema.Types.ObjectId, ref: 'Community' },
  body: { type: String, trim: true, maxlength: 50000 },
  hashtags: [{ type: String, trim: true, lowercase: true }],
  type: { type: String, enum: ['post', 'article'], default: 'post' },
  status: { type: String, enum: ['published', 'pending', 'rejected'], default: 'published' },
  media: [{
    url: { type: String, required: true },
    kind: { type: String, enum: ['image', 'video', 'audio'], default: 'image' },
    alt: String,
    storageKey: String,
    thumbnailUrl: String
  }],
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  commentsCount: { type: Number, default: 0 },
  sharesCount: { type: Number, default: 0 }
}, { timestamps: true });

module.exports = mongoose.model('Post', postSchema);
