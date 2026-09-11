const mongoose = require('mongoose');

const communitySchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, unique: true },
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
  description: { type: String, required: true, trim: true, maxlength: 280 },
  membersCount: { type: Number, default: 0 },
  coverImage: String
}, { timestamps: true });

module.exports = mongoose.model('Community', communitySchema);
