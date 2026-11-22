const mongoose = require('mongoose');

const sourceSchema = new mongoose.Schema({
  type: { type: String, enum: ['post', 'comment', 'profile', 'community', 'topic', 'statistics'], required: true },
  id: { type: String, required: true, maxlength: 64 },
  title: { type: String, maxlength: 200, default: '' },
  url: { type: String, maxlength: 300, required: true },
  excerpt: { type: String, maxlength: 1400, default: '' },
  createdAt: Date
}, { _id: false });

const contextSchema = new mongoose.Schema({
  type: { type: String, maxlength: 32, default: '' },
  title: { type: String, maxlength: 200, default: '' },
  text: { type: String, maxlength: 1400, default: '' },
  url: { type: String, maxlength: 300, default: '' }
}, { _id: false });

const aiMessageSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'AiConversation', required: true },
  role: { type: String, enum: ['user', 'assistant'], required: true },
  replyTo: { type: mongoose.Schema.Types.ObjectId, ref: 'AiMessage', default: null },
  content: { type: String, required: true, maxlength: 12000 },
  sources: { type: [sourceSchema], default: [] },
  context: { type: [contextSchema], default: [] },
  actionId: { type: mongoose.Schema.Types.ObjectId, ref: 'AiAction', default: null },
  feedback: { type: String, enum: ['helpful', 'unhelpful', null], default: null }
}, { timestamps: true });

aiMessageSchema.index({ user: 1, conversation: 1, createdAt: 1 });
aiMessageSchema.index({ user: 1, conversation: 1, replyTo: 1 });
aiMessageSchema.index({ user: 1, content: 'text' }, { name: 'ai_user_message_search' });

module.exports = mongoose.model('AiMessage', aiMessageSchema);
