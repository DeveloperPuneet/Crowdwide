const AiAction = require('../models/AiAction');

async function preserveAiActionAuditTrail() {
  if (AiAction.db.readyState !== 1) return;
  const indexes = await AiAction.collection.indexes();
  const expiringAllActions = indexes.find((index) =>
    index.key?.expiresAt === 1 &&
    index.expireAfterSeconds === 0 &&
    !index.partialFilterExpression
  );
  if (expiringAllActions) await AiAction.collection.dropIndex(expiringAllActions.name);
  await AiAction.createIndexes();
}

module.exports = { preserveAiActionAuditTrail };
