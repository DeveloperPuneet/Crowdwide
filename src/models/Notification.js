const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  type: { type: String, enum: ['like', 'comment', 'reply', 'mention', 'follow', 'join_request', 'join_approved', 'new_device', 'message'], required: true },
  post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' },
  community: { type: mongoose.Schema.Types.ObjectId, ref: 'Community' },
  message: { type: String, required: true },
  url: { type: String, maxlength: 500 },
  readAt: Date
}, { timestamps: true });

notificationSchema.index({ recipient: 1, readAt: 1, createdAt: -1 });
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model('Notification', notificationSchema);
