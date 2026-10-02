const mongoose = require('mongoose');

const RETENTION_SECONDS = 30 * 24 * 60 * 60;

// `kind: 'system'` rows are the little centered notes ("Sam added Priya").
const groupMessageSchema = new mongoose.Schema({
  group: { type: mongoose.Schema.Types.ObjectId, ref: 'GroupConversation', required: true, index: true },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  kind: { type: String, enum: ['message', 'system'], default: 'message' },
  body: { type: String, trim: true, maxlength: 2000, default: '' },
  gif: { url: String, preview: String, title: String, width: Number, height: Number },
  attachment: {
    filename: { type: String, maxlength: 180 },
    contentType: { type: String, enum: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'text/plain'] },
    size: { type: Number, max: 3 * 1024 * 1024 },
    data: Buffer
  },
  sharedPost: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' },
  reactions: [{ emoji: { type: String, required: true }, users: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }] }]
}, { timestamps: true });

groupMessageSchema.pre('validate', function requireContent(next) {
  if (!this.body && !this.gif?.url && !this.attachment?.data && !this.sharedPost) this.invalidate('body', 'A message needs text, an attachment, a GIF or a shared post.');
  next();
});

groupMessageSchema.index({ group: 1, createdAt: -1 });
groupMessageSchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_SECONDS });

module.exports = mongoose.model('GroupMessage', groupMessageSchema);
