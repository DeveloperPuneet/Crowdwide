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
    { $project: { body: 1, likesTotal: 1, createdAt: 1, hashtags: 1, author: { _id: '$authorDoc._id', name: '$authorDoc.name', profilePicture: '$authorDoc.profilePicture' } } }
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

module.exports = { getViralPosts, getPopularPeople, getTrendingHashtags };
