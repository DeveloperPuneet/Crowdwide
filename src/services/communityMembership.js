const mongoose = require('mongoose');
const Community = require('../models/Community');
const User = require('../models/User');

function withoutUser(arrayPath, userId, userField = null) {
  const valuePath = userField ? `$$entry.${userField}` : '$$entry';
  return {
    $filter: {
      input: { $ifNull: [`$${arrayPath}`, []] },
      as: 'entry',
      cond: { $ne: [valuePath, userId] }
    }
  };
}

async function reconcileCommunityMembers(community) {
  const originalMembers = community.members || [];
  const members = originalMembers.length
    ? await User.find({ _id: { $in: originalMembers } }).select('name profilePicture').lean()
    : [];
  const existingIds = new Map(members.map((member) => [String(member._id), member._id]));
  const validIds = [];
  const seen = new Set();
  for (const memberId of originalMembers) {
    const key = String(memberId);
    if (existingIds.has(key) && !seen.has(key)) {
      validIds.push(existingIds.get(key));
      seen.add(key);
    }
  }
  const staleOrDuplicateMembers = validIds.length !== originalMembers.length;
  if (staleOrDuplicateMembers) {
    await Community.updateOne(
      { _id: community._id, members: originalMembers },
      [{ $set: { members: validIds, membersCount: validIds.length } }]
    );
  }
  community.members = validIds;
  community.membersCount = validIds.length;
  return members;
}

async function removeUserFromCommunities(userId) {
  const id = new mongoose.Types.ObjectId(String(userId));
  const membersWithoutUser = withoutUser('members', id);
  return Community.updateMany(
    {
      $or: [
        { members: id },
        { moderators: id },
        { memberRoles: { $elemMatch: { user: id } } },
        { joinRequests: { $elemMatch: { user: id } } }
      ]
    },
    [{
      $set: {
        members: membersWithoutUser,
        membersCount: { $size: membersWithoutUser },
        moderators: withoutUser('moderators', id),
        memberRoles: withoutUser('memberRoles', id, 'user'),
        joinRequests: withoutUser('joinRequests', id, 'user')
      }
    }]
  );
}

module.exports = { reconcileCommunityMembers, removeUserFromCommunities };
