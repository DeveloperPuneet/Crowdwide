const Post = require('../models/Post');
const User = require('../models/User');

async function getViralPosts(limit = 4) {
  return Post.aggregate([
    { $match: { status: 'published' } },
    { $addFields: { likesTotal: { $size: { $ifNull: ['$likes', []] } } } },
    { $lookup: { from: 'communities', localField: 'community', foreignField: '_id', as: 'communityDoc' } },
    { $match: { $or: [{ community: null }, { 'communityDoc.isPrivate': false }] } },
    { $sort: { likesTotal: -1, createdAt: -1 } },
    { $limit: limit },
    { $lookup: { from: 'users', localField: 'author', foreignField: '_id', as: 'authorDoc' } },
    { $unwind: '$authorDoc' },
    { $project: { body: 1, type: 1, likesTotal: 1, createdAt: 1, hashtags: 1, author: { _id: '$authorDoc._id', name: '$authorDoc.name', profilePicture: '$authorDoc.profilePicture' } } }
  ]);
}

async function getPopularPeople(limit = 5, excludeIds = []) {
  return User.aggregate([
    { $match: { following: { $exists: true, $ne: [] } } },
    { $unwind: '$following' },
    { $match: excludeIds.length ? { following: { $nin: excludeIds } } : {} },
    { $group: { _id: '$following', followers: { $sum: 1 } } },
    { $sort: { followers: -1 } },
    { $limit: limit },
    { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
    { $unwind: '$user' },
    { $project: { _id: '$user._id', name: '$user.name', profilePicture: '$user.profilePicture', bio: '$user.bio', followers: 1 } }
  ]);
}

// "Common interests": people whose own profile hashtags overlap with the
// tags this person cares about (their stated interests plus - upstream -
// their learned feed interests), ranked by how much overlap there is.
async function getCommonInterestPeople(tags, excludeIds = [], limit = 6) {
  if (!tags.length) return [];
  const rows = await User.aggregate([
    { $match: { _id: { $nin: excludeIds }, isVerified: true, hashtags: { $in: tags } } },
    { $project: { name: 1, bio: 1, profilePicture: 1, hashtags: 1, followersCount: { $size: { $ifNull: ['$following', []] } } } },
    { $addFields: { sharedTags: { $setIntersection: ['$hashtags', tags] } } },
    { $addFields: { sharedCount: { $size: '$sharedTags' } } },
    { $sort: { sharedCount: -1, followersCount: -1 } },
    { $limit: limit },
    { $project: { name: 1, bio: 1, profilePicture: 1, sharedTags: { $slice: ['$sharedTags', 3] } } }
  ]);
  return rows;
}

// "Common creators": people followed by the accounts this person already
// follows, but that they don't follow yet - the classic "people you may
// know" via a shared network, ranked by how many of the accounts they
// follow also follow this person.
async function getMutualNetworkPeople(followingIds, excludeIds = [], limit = 6) {
  if (!followingIds.length) return [];
  return User.aggregate([
    { $match: { _id: { $in: followingIds }, following: { $exists: true, $ne: [] } } },
    { $unwind: '$following' },
    { $match: { following: { $nin: excludeIds } } },
    { $group: { _id: '$following', mutualCount: { $sum: 1 } } },
    { $sort: { mutualCount: -1 } },
    { $limit: limit },
    { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
    { $unwind: '$user' },
    { $match: { 'user.isVerified': true } },
    { $project: { _id: '$user._id', name: '$user.name', profilePicture: '$user.profilePicture', bio: '$user.bio', mutualCount: 1 } }
  ]);
}

// "Trending creators": whose recent posts (last 7 days) are pulling real
// engagement right now - a much better "trending" signal than lifetime
// follower count, which just re-surfaces the same big accounts forever.
async function getTrendingCreators(excludeIds = [], limit = 6) {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  return Post.aggregate([
    { $match: { status: 'published', createdAt: { $gte: since }, author: { $nin: excludeIds } } },
    { $addFields: { engagement: { $add: [{ $size: { $ifNull: ['$likes', []] } }, { $ifNull: ['$commentsCount', 0] }, { $ifNull: ['$sharesCount', 0] }] } } },
    { $group: { _id: '$author', engagement: { $sum: '$engagement' }, posts: { $sum: 1 } } },
    { $match: { engagement: { $gt: 0 } } },
    { $sort: { engagement: -1 } },
    { $limit: limit },
    { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
    { $unwind: '$user' },
    { $match: { 'user.isVerified': true } },
    { $project: { _id: '$user._id', name: '$user.name', profilePicture: '$user.profilePicture', bio: '$user.bio', engagement: 1 } }
  ]);
}

async function getNewJoiners(excludeIds = [], limit = 6) {
  return User.find({ _id: { $nin: excludeIds }, isVerified: true }).sort({ createdAt: -1 }).limit(limit).select('name bio profilePicture createdAt').lean();
}

async function getTrendingHashtags(limit = 10) {
  return Post.aggregate([
    { $match: { status: 'published', hashtags: { $exists: true, $ne: [] } } },
    { $unwind: '$hashtags' },
    { $group: { _id: '$hashtags', posts: { $sum: 1 }, latest: { $max: '$createdAt' } } },
    { $sort: { posts: -1, latest: -1 } },
    { $limit: limit },
    { $project: { _id: 0, tag: '$_id', posts: 1 } }
  ]);
}

module.exports = { getViralPosts, getPopularPeople, getTrendingHashtags, getCommonInterestPeople, getMutualNetworkPeople, getTrendingCreators, getNewJoiners };
