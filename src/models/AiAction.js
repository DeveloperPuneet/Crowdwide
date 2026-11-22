const mongoose = require('mongoose');

const aiActionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'AiConversation', required: true },
  kind: { type: String, enum: ['create_post', 'edit_post', 'delete_post'], required: true },
  post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', default: null },
  postPreview: { type: String, maxlength: 180, default: '' },
  content: { type: String, maxlength: 4000, default: '' },
  revision: { type: Number, min: 0, default: null },
  status: { type: String, enum: ['pending', 'confirmed', 'completed', 'failed', 'canceled'], default: 'pending' },
  expiresAt: { type: Date, required: true }
}, { timestamps: true });

aiActionSchema.index({ user: 1, conversation: 1 });
aiActionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('AiAction', aiActionSchema);
