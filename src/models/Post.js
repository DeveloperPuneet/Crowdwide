const mongoose = require('mongoose');

const postSchema = new mongoose.Schema({
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  body: { type: String, trim: true, maxlength: 5000 },
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
