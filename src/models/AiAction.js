const mongoose = require('mongoose');

const aiActionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'AiConversation', required: true },
  sourceMessage: { type: mongoose.Schema.Types.ObjectId, ref: 'AiMessage' },
  kind: { type: String, enum: ['create_post', 'edit_post', 'delete_post', 'create_comment', 'reply_comment', 'send_message'], required: true },
  post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', default: null },
  comment: { type: mongoose.Schema.Types.ObjectId, ref: 'Comment', default: null },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  group: { type: mongoose.Schema.Types.ObjectId, ref: 'GroupConversation', default: null },
  postPreview: { type: String, maxlength: 180, default: '' },
  targetLabel: { type: String, maxlength: 120, default: '' },
  content: { type: String, maxlength: 4000, default: '' },
  revision: { type: Number, min: 0, default: null },
  status: { type: String, enum: ['pending', 'confirmed', 'completed', 'failed', 'canceled'], default: 'pending' },
  resultId: { type: mongoose.Schema.Types.ObjectId, default: null },
  failureReason: { type: String, maxlength: 300, default: '' },
  expiresAt: { type: Date, required: true }
}, { timestamps: true });

aiActionSchema.index({ user: 1, conversation: 1 });
aiActionSchema.index({ sourceMessage: 1 }, { unique: true, partialFilterExpression: { sourceMessage: { $type: 'objectId' } } });
aiActionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('AiAction', aiActionSchema);
