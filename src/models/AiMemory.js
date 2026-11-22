const mongoose = require('mongoose');

const aiMemorySchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  kind: { type: String, enum: ['preference', 'ongoing_task', 'summary'], default: 'preference' },
  text: { type: String, required: true, trim: true, maxlength: 1000 }
}, { timestamps: true });

aiMemorySchema.index({ user: 1, updatedAt: -1 });

module.exports = mongoose.model('AiMemory', aiMemorySchema);
