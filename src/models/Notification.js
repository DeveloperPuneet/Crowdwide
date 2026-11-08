const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  type: { type: String, enum: ['like', 'comment', 'reply', 'mention', 'follow', 'join_request', 'join_approved', 'new_device', 'message', 'reminder', 'badge', 'follow_request', 'post_reply', 'setup'], required: true },
  post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' },
  community: { type: mongoose.Schema.Types.ObjectId, ref: 'Community' },
  // Which badge a 'badge' notification is about (shows its medal), or which checklist item a 'setup' one is about.
  badgeKey: { type: String, maxlength: 60 },
  setupKey: { type: String, maxlength: 60 },
  message: { type: String, required: true },
  url: { type: String, maxlength: 500 },
  readAt: Date
}, { timestamps: true });

notificationSchema.index({ recipient: 1, readAt: 1, createdAt: -1 });
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model('Notification', notificationSchema);
