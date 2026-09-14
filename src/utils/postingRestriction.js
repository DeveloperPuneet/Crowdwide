const User = require('../models/User');

// Returns a user-facing message if the user is currently blocked from
// posting/commenting by a moderator-imposed restriction, or null if they're
// clear to post. Distinct from account suspension (which blocks login
// entirely) and from the personal "muted users" preference (which only
// affects what the muting user sees, not what the muted user can do).
async function checkPostingRestriction(userId) {
  const user = await User.findById(userId).select('postingRestrictedUntil postingRestrictionReason').lean();
  if (!user?.postingRestrictedUntil || user.postingRestrictedUntil <= Date.now()) return null;
  const until = new Date(user.postingRestrictedUntil).toLocaleString();
  return `You're temporarily restricted from posting until ${until}.${user.postingRestrictionReason ? ` Reason: ${user.postingRestrictionReason}` : ''}`;
}

module.exports = { checkPostingRestriction };
