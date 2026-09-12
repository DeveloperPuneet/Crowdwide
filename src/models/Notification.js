const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  type: { type: String, enum: ['like', 'comment', 'reply', 'mention', 'follow', 'join_request', 'join_approved', 'new_device'], required: true },
  post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' },
  community: { type: mongoose.Schema.Types.ObjectId, ref: 'Community' },
  message: { type: String, required: true },
  readAt: Date
}, { timestamps: true });

module.exports = mongoose.model('Notification', notificationSchema);
