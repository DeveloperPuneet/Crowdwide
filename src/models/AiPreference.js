const mongoose = require('mongoose');

const aiPreferenceSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  theme: { type: String, enum: ['auto', 'light', 'dark'], default: 'auto' }
}, { timestamps: true });

module.exports = mongoose.model('AiPreference', aiPreferenceSchema);
