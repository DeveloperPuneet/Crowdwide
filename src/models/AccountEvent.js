const mongoose = require('mongoose');

const accountEventSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: {
    type: String,
    required: true,
    enum: [
      'login', 'password-changed', 'two-factor-enabled', 'two-factor-disabled',
      'recovery-codes-regenerated', 'suspended', 'suspension-lifted',
      'posting-restricted', 'posting-restriction-lifted', 'warning-issued',
      'warning-removed', 'appeal-submitted', 'appeal-approved', 'appeal-denied'
    ]
  },
  detail: { type: String, trim: true, maxlength: 300, default: '' }
}, { timestamps: true });

accountEventSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('AccountEvent', accountEventSchema);
