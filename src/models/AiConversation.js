const mongoose = require('mongoose');

const aiConversationSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, trim: true, maxlength: 80, default: 'New conversation' },
  lastMessageAt: { type: Date, default: Date.now }
}, { timestamps: true });

aiConversationSchema.index({ user: 1, lastMessageAt: -1 });

module.exports = mongoose.model('AiConversation', aiConversationSchema);
