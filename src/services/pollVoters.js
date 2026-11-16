const mongoose = require('mongoose');
const User = require('../models/User');

const idOf = (value) => String(value?._id || value || '');

function canSeeVoter({ voterId, viewerId, pollAuthors, viewerFollowing, voterFollowsViewer, voterPrivacy }) {
  if (voterId === viewerId || pollAuthors.has(viewerId)) return true;
  const viewerFollowsVoter = viewerFollowing.has(voterId);
  const connected = viewerFollowsVoter || voterFollowsViewer.has(voterId);
  return connected && (voterPrivacy !== 'followers' || viewerFollowsVoter);
}

async function attachPollVoters(posts, viewerId) {
  if (!posts?.length || !mongoose.isValidObjectId(viewerId)) return posts || [];

  const voterIds = [...new Set(posts.flatMap((post) => (post.poll?.options || []).flatMap((option) => (option.votes || []).map(idOf))).filter(mongoose.isValidObjectId))];
  if (!voterIds.length) return posts;

  const viewerObjectId = new mongoose.Types.ObjectId(viewerId);
  const [viewer, voters, voterFollowers] = await Promise.all([
    User.findById(viewerObjectId).select('following').lean(),
    User.find({ _id: { $in: voterIds } }).select('name profilePicture privacy').lean(),
    User.find({ _id: { $in: voterIds }, following: viewerObjectId }).select('_id').lean()
  ]);
  const usersById = new Map(voters.map((user) => [String(user._id), user]));
  const viewerFollowing = new Set((viewer?.following || []).map(idOf));
  const voterFollowsViewer = new Set(voterFollowers.map((user) => String(user._id)));

  return posts.map((post) => {
    const pollAuthors = new Set([post.author, ...(post.coAuthors || [])].map(idOf));
    const voterOptions = (post.poll?.options || []).map((option) => ({
      label: option.label,
      voters: (option.votes || []).map((id) => usersById.get(idOf(id))).filter(Boolean)
        .filter((voter) => canSeeVoter({
          voterId: String(voter._id),
          viewerId: String(viewerObjectId),
          pollAuthors,
          viewerFollowing,
          voterFollowsViewer,
          voterPrivacy: voter.privacy
        }))
    })).filter((option) => option.voters.length);
    return { ...post, poll: post.poll ? { ...post.poll, voterOptions } : post.poll };
  });
}

module.exports = { attachPollVoters, canSeeVoter };
