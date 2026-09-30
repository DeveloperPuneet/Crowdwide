// Deployment environment awareness. Set APP_ENV=staging on a second
// deployment (own MONGODB_URI, own SESSION_SECRET, own keys) to get safe
// staging behaviour from the same codebase:
//   - every response carries noindex/nofollow and robots.txt disallows all
//   - a visible "Staging" banner is shown on every page
//   - outbound email only goes to STAGING_MAIL_ALLOWLIST (addresses or
//     @domains, comma-separated); anything else is logged and skipped, so a
//     staging copy of production data can never email real users
//   - the keep-alive ping is left off unless explicitly enabled
function appEnv() {
  return String(process.env.APP_ENV || '').trim().toLowerCase();
}

function isStaging() {
  return appEnv() === 'staging';
}

function stagingAllowlist() {
  return String(process.env.STAGING_MAIL_ALLOWLIST || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

// Recipients may be "a@b.com" or "Name <a@b.com>", or a list of either.
function recipientAddresses(to) {
  const list = Array.isArray(to) ? to : String(to || '').split(',');
  return list.map((entry) => {
    const match = String(entry).match(/<([^>]+)>/);
    return (match ? match[1] : String(entry)).trim().toLowerCase();
  }).filter(Boolean);
}

function mailAllowed(to) {
  if (!isStaging()) return true;
  const allow = stagingAllowlist();
  const recipients = recipientAddresses(to);
  if (!recipients.length || !allow.length) return false;
  return recipients.every((address) => allow.some((entry) => (entry.startsWith('@') ? address.endsWith(entry) : address === entry)));
}

function stagingMiddleware(req, res, next) {
  if (isStaging()) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  }
  res.locals.isStaging = isStaging();
  next();
}

module.exports = { appEnv, isStaging, mailAllowed, stagingMiddleware, recipientAddresses };
