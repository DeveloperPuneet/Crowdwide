const mongoose = require('mongoose');

// A direct message is text, a GIF, a shared post, or any mix of those.
const messageSchema = new mongoose.Schema({
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  body: { type: String, trim: true, maxlength: 2000, default: '' },
  gif: { url: String, preview: String, title: String, width: Number, height: Number },
  sharedPost: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' },
  readAt: Date
}, { timestamps: true });

messageSchema.pre('validate', function requireContent(next) {
  if (!this.body && !this.gif?.url && !this.sharedPost) this.invalidate('body', 'A message needs text, a GIF or a shared post.');
  next();
});

messageSchema.index({ sender: 1, recipient: 1, createdAt: -1 });
messageSchema.index({ recipient: 1, sender: 1, readAt: 1 });

module.exports = mongoose.model('Message', messageSchema);
