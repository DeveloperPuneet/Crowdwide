const AiPreference = require('../models/AiPreference');

async function enableLocalInferenceByDefault() {
  return AiPreference.updateMany(
    { localInferenceDefaultMigrated: { $ne: true } },
    { $set: { localInference: true, localInferenceDefaultMigrated: true } }
  );
}

module.exports = { enableLocalInferenceByDefault };
