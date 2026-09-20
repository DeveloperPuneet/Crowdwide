const mongoose = require('mongoose');

// One row per (person, post, chat) a post was sent to inside Crowdwide.
// Post.sharesCount only goes up when a NEW row is inserted, so re-sending the
// same post to the same chat - or copying its link / sharing it elsewhere -
// never inflates the number.
const postShareSchema = new mongoose.Schema({
  post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  targetType: { type: String, enum: ['user', 'group'], required: true },
  target: { type: mongoose.Schema.Types.ObjectId, required: true }
}, { timestamps: { createdAt: true, updatedAt: false } });

postShareSchema.index({ post: 1, user: 1, targetType: 1, target: 1 }, { unique: true });
postShareSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('PostShare', postShareSchema);
