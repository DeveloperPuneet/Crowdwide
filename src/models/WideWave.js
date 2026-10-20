const mongoose = require('mongoose');

// A WideWave (written ww/name) is an open topic space: anyone can read it, post to it
// and engage with its posts - no joining or following. Each has exactly one topic.
// Only the description and hashtags can be edited by the creator; moderation is done
// by official Crowdwide moderators only.
const wideWaveSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true, lowercase: true, trim: true, match: /^[a-z0-9_]{3,30}$/ },
  description: { type: String, required: true, trim: true, maxlength: 200 },
  hashtags: [{ type: String, trim: true, lowercase: true }],
  creator: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  status: { type: String, enum: ['active', 'removed'], default: 'active', index: true },
  removedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  removedReason: { type: String, trim: true, maxlength: 300, default: '' },
  postsCount: { type: Number, default: 0 },
  lastPostAt: { type: Date, default: null }
}, { timestamps: true });

wideWaveSchema.index({ postsCount: -1 });
wideWaveSchema.index({ hashtags: 1 });

module.exports = mongoose.model('WideWave', wideWaveSchema);
