// Signed, login-free unsubscribe links for the come-back reminder emails.
// The token is an HMAC of the member id, so a link can only be made by the
// server and cannot be guessed or reused for any other member or purpose.
const crypto = require('crypto');

function secret() {
  return process.env.UNSUBSCRIBE_SECRET || process.env.SESSION_SECRET || 'crowdwide-development-secret';
}

function signReminderToken(userId) {
  return crypto.createHmac('sha256', secret()).update(`reminders:${String(userId)}`).digest('hex').slice(0, 32);
}

function verifyReminderToken(userId, token) {
  if (typeof token !== 'string' || token.length !== 32) return false;
  const expected = Buffer.from(signReminderToken(userId));
  const given = Buffer.from(token);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function reminderUnsubscribeUrl(appUrl, userId) {
  return `${String(appUrl).replace(/\/$/, '')}/unsubscribe/reminders/${userId}/${signReminderToken(userId)}`;
}

module.exports = { signReminderToken, verifyReminderToken, reminderUnsubscribeUrl };
