const AiAction = require('../models/AiAction');
const AiConversation = require('../models/AiConversation');
const AiMemory = require('../models/AiMemory');
const AiMessage = require('../models/AiMessage');
const AiPreference = require('../models/AiPreference');

function deleteAiDataForUser(userId) {
  return Promise.all([
    AiAction.deleteMany({ user: userId }),
    AiConversation.deleteMany({ user: userId }),
    AiMemory.deleteMany({ user: userId }),
    AiMessage.deleteMany({ user: userId }),
    AiPreference.deleteMany({ user: userId })
  ]);
}

module.exports = { deleteAiDataForUser };
