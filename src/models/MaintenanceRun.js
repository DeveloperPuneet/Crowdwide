const mongoose = require('mongoose');

const maintenanceRunSchema = new mongoose.Schema({
  task: { type: String, required: true, maxlength: 40 },
  status: { type: String, enum: ['success', 'partial', 'failed'], required: true },
  triggeredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  scheduled: { type: Boolean, default: false },
  results: { type: mongoose.Schema.Types.Mixed, default: {} },
  startedAt: { type: Date, required: true },
  finishedAt: { type: Date, required: true }
}, { timestamps: true });

maintenanceRunSchema.index({ createdAt: -1 });
maintenanceRunSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

module.exports = mongoose.model('MaintenanceRun', maintenanceRunSchema);
