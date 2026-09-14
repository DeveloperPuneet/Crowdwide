const mongoose = require('mongoose');

const appealSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  actionType: { type: String, enum: ['suspension', 'posting-restriction', 'warning'], required: true },
  // For a warning appeal, which specific warning subdocument (User.warnings._id)
  // this refers to - lets a moderator remove exactly that one warning on
  // approval without guessing which of possibly several warnings is meant.
  warningId: { type: mongoose.Schema.Types.ObjectId },
  // A snapshot of the reason/warning text at the time the appeal was filed,
  // so the appeal record stays meaningful even after the underlying
  // suspension/restriction/warning is cleared (approved or otherwise).
  reasonSnapshot: { type: String, trim: true, maxlength: 500, default: '' },
  message: { type: String, trim: true, required: true, maxlength: 1000 },
  status: { type: String, enum: ['pending', 'approved', 'denied'], default: 'pending', index: true },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: Date,
  reviewNote: { type: String, trim: true, maxlength: 500, default: '' }
}, { timestamps: true });

appealSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('Appeal', appealSchema);
