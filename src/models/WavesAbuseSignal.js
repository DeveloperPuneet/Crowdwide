const mongoose = require('mongoose');

const wavesAbuseSignalSchema = new mongoose.Schema({
  signalKey: { type: String, required: true, unique: true, maxlength: 200 },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  transferCount: { type: Number, required: true, min: 1 },
  totalWaves: { type: Number, required: true, min: 0 },
  reason: { type: String, trim: true, maxlength: 300, required: true },
  windowStartedAt: { type: Date, required: true },
  lastSeenAt: { type: Date, required: true },
  status: { type: String, enum: ['open', 'reviewed'], default: 'open', index: true },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedAt: Date,
  reviewNote: { type: String, trim: true, maxlength: 500, default: '' }
}, { timestamps: true });

wavesAbuseSignalSchema.index({ status: 1, lastSeenAt: -1 });

module.exports = mongoose.model('WavesAbuseSignal', wavesAbuseSignalSchema);
