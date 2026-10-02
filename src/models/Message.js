const mongoose = require('mongoose');

const RETENTION_SECONDS = 30 * 24 * 60 * 60;

// A direct message is text, a GIF, a shared post, or any mix of those.
const messageSchema = new mongoose.Schema({
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  body: { type: String, trim: true, maxlength: 2000, default: '' },
  gif: { url: String, preview: String, title: String, width: Number, height: Number },
  attachment: {
    filename: { type: String, maxlength: 180 },
    contentType: { type: String, enum: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'text/plain'] },
    size: { type: Number, max: 3 * 1024 * 1024 },
    data: Buffer
  },
  sharedPost: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' },
  readAt: Date,
  reactions: [{ emoji: { type: String, required: true }, users: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }] }]
}, { timestamps: true });

messageSchema.pre('validate', function requireContent(next) {
  if (!this.body && !this.gif?.url && !this.attachment?.data && !this.sharedPost) this.invalidate('body', 'A message needs text, an attachment, a GIF or a shared post.');
  next();
});

messageSchema.index({ sender: 1, recipient: 1, createdAt: -1 });
messageSchema.index({ recipient: 1, sender: 1, readAt: 1 });
messageSchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_SECONDS });

module.exports = mongoose.model('Message', messageSchema);
