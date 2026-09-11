const mongoose = require('mongoose');

const postSchema = new mongoose.Schema({
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  community: { type: mongoose.Schema.Types.ObjectId, ref: 'Community' },
  body: { type: String, trim: true, maxlength: 50000 },
  type: { type: String, enum: ['post', 'article'], default: 'post' },
  media: [{
    url: { type: String, required: true },
    kind: { type: String, enum: ['image', 'video', 'audio'], default: 'image' },
    alt: String,
    storageKey: String
  }],
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  commentsCount: { type: Number, default: 0 }
}, { timestamps: true });

module.exports = mongoose.model('Post', postSchema);
