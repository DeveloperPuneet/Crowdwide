const mongoose = require('mongoose');
const AiAction = require('../models/AiAction');

async function loadConfirmedAiAction(actionId, userId, kind) {
  if (!actionId) return null;
  if (!mongoose.isValidObjectId(actionId)) return false;
  return AiAction.findOne({
    _id: actionId,
    user: userId,
    kind,
    $or: [
      { status: 'completed' },
      { status: 'confirmed', expiresAt: { $gt: new Date() } }
    ]
  });
}

async function completeAiAction(action, resultId = null) {
  if (!action) return;
  await AiAction.updateOne(
    { _id: action._id, status: 'confirmed' },
    { $set: { status: 'completed', ...(resultId ? { resultId } : {}) } }
  );
}

module.exports = { loadConfirmedAiAction, completeAiAction };
