const AccountEvent = require('../models/AccountEvent');
const logger = require('./logger');

// Logs one entry to a user's own account-history timeline (Settings >
// History). Deliberately fire-and-forget with its own error handling: a
// failure to WRITE a log entry must never break the login/password-change/
// suspension/etc. action that triggered it - the same lesson this whole
// session has been full of (mailer, push, link preview all follow the same
// shape).
function logEvent(userId, type, detail = '') {
  AccountEvent.create({ user: userId, type, detail }).catch((error) => {
    logger.error('Failed to record account history event', { userId, type, error });
  });
}

module.exports = { logEvent };
