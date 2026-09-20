const mongoose = require('mongoose');

// `creator` is the owner. `admins` may add/remove people, rename the group,
// change its picture and manage the invite link; the owner is always an admin.
const groupConversationSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  description: { type: String, trim: true, maxlength: 240, default: '' },
  avatar: { type: String, default: '' },
  creator: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  admins: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }],
  // Random, unguessable code behind /groups/join/<code>. Absent = no link.
  inviteCode: { type: String, index: { unique: true, sparse: true } }
}, { timestamps: true });

groupConversationSchema.index({ members: 1, updatedAt: -1 });

module.exports = mongoose.model('GroupConversation', groupConversationSchema);
