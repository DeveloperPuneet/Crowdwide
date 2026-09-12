const mongoose = require('mongoose');

const joinRequestSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now }
}, { _id: false });

const memberRoleSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  role: { type: String, enum: ['member', 'moderator'], default: 'member' }
}, { _id: false });

const communitySchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true, trim: true, unique: true },
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
  description: { type: String, required: true, trim: true, maxlength: 280 },
  guidelines: { type: String, trim: true, maxlength: 4000, default: '' },
  category: { type: String, trim: true, lowercase: true, default: 'general' },
  hashtags: [{ type: String, trim: true, lowercase: true }],
  isPrivate: { type: Boolean, default: false },
  requireApproval: { type: Boolean, default: false },
  membersCount: { type: Number, default: 0 },
  members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  memberRoles: [memberRoleSchema],
  moderators: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  joinRequests: [joinRequestSchema],
  bannedWords: [{ type: String, trim: true, lowercase: true }],
  coverImage: String,
  avatarImage: String
}, { timestamps: true });

module.exports = mongoose.model('Community', communitySchema);
