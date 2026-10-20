// Private profiles (privacy === 'followers'): everyone can see the name, picture,
// bio and the NUMBER of posts, followers and following. The posts themselves,
// the follower/following lists, activity, likes, comments, communities and
// stats are visible only to the member, people they have approved as followers,
// and staff. Following a private profile sends a request that the member approves.
const User = require('../models/User');

const STAFF_ROLES = ['admin', 'moderator'];

// IDs of private-profile members whose content `viewerId` may NOT see
// (everyone private except the viewer and the people the viewer follows).
// With no viewer (signed-out visitors, public feeds) that is every private member.
async function getHiddenAuthorIds(viewerId = null, following = null) {
  let followed = following;
  if (viewerId && !followed) {
    const viewer = await User.findById(viewerId).select('following').lean();
    followed = viewer?.following || [];
  }
  const keep = [...(followed || []), ...(viewerId ? [viewerId] : [])].map(String);
  return User.find({ privacy: 'followers', ...(keep.length ? { _id: { $nin: keep } } : {}) }).distinct('_id');
}

// Can this viewer see the private parts of this profile?
function canSeeProfileDetails({ profileUser, viewerId, viewerFollowing = [], viewerRole = 'user' }) {
  if (!profileUser || profileUser.privacy !== 'followers') return true;
  if (String(profileUser._id) === String(viewerId)) return true;
  if (STAFF_ROLES.includes(viewerRole)) return true;
  return viewerFollowing.some((id) => String(id) === String(profileUser._id));
}

module.exports = { getHiddenAuthorIds, canSeeProfileDetails, STAFF_ROLES };
