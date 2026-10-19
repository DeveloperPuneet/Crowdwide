// Signed, login-free unsubscribe links for the optional lifecycle emails
// ("reminders" = come-back reminders, "welcome" = welcome series and first-reply).
// The token is an HMAC of the kind and member id, so a link can only be made by
// the server and cannot be guessed or reused for another member or another kind.
const crypto = require('crypto');

const KINDS = {
  reminders: 'emailReminders',
  welcome: 'emailWelcome'
};

function secret() {
  return process.env.UNSUBSCRIBE_SECRET || process.env.SESSION_SECRET || 'crowdwide-development-secret';
}

function signToken(kind, userId) {
  return crypto.createHmac('sha256', secret()).update(`${kind}:${String(userId)}`).digest('hex').slice(0, 32);
}

function verifyToken(kind, userId, token) {
  if (!Object.hasOwn(KINDS, kind) || typeof token !== 'string' || token.length !== 32) return false;
  const expected = Buffer.from(signToken(kind, userId));
  const given = Buffer.from(token);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function unsubscribeUrl(appUrl, kind, userId) {
  return `${String(appUrl).replace(/\/$/, '')}/unsubscribe/${kind}/${userId}/${signToken(kind, userId)}`;
}

// Back-compat names used by the come-back reminders.
const signReminderToken = (userId) => signToken('reminders', userId);
const verifyReminderToken = (userId, token) => verifyToken('reminders', userId, token);
const reminderUnsubscribeUrl = (appUrl, userId) => unsubscribeUrl(appUrl, 'reminders', userId);

module.exports = { KINDS, signToken, verifyToken, unsubscribeUrl, signReminderToken, verifyReminderToken, reminderUnsubscribeUrl };
