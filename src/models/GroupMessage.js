const mongoose = require('mongoose');

// `kind: 'system'` rows are the little centered notes ("Sam added Priya").
const groupMessageSchema = new mongoose.Schema({
  group: { type: mongoose.Schema.Types.ObjectId, ref: 'GroupConversation', required: true, index: true },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  kind: { type: String, enum: ['message', 'system'], default: 'message' },
  body: { type: String, trim: true, maxlength: 2000, default: '' },
  gif: { url: String, preview: String, title: String, width: Number, height: Number },
  sharedPost: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' }
}, { timestamps: true });

groupMessageSchema.pre('validate', function requireContent(next) {
  if (!this.body && !this.gif?.url && !this.sharedPost) this.invalidate('body', 'A message needs text, a GIF or a shared post.');
  next();
});

groupMessageSchema.index({ group: 1, createdAt: -1 });

module.exports = mongoose.model('GroupMessage', groupMessageSchema);
