const Community = require('../models/Community');

// IDs of private communities the given viewer is NOT a member of - merge
// `community: { $nin: restrictedIds } ` into any Post query that isn't
// already scoped to a specific community whose membership the caller has
// separately confirmed. Posts with no community (community is null/unset)
// are unaffected by $nin and remain visible, which is the correct default.
//
// Pass `null`/`undefined` for userId (a logged-out viewer) to restrict
// every private community, not just the ones a particular account hasn't
// joined.
async function getRestrictedCommunityIds(userId) {
  const query = userId ? { isPrivate: true, members: { $ne: userId } } : { isPrivate: true };
  return Community.find(query).distinct('_id');
}

module.exports = { getRestrictedCommunityIds };
