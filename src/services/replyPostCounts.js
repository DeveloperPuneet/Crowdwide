const mongoose = require('mongoose');
const Post = require('../models/Post');

async function attachReplyPostCounts(posts) {
  if (!posts?.length) return posts || [];
  const ids = [...new Set(posts.map((post) => String(post._id)).filter(mongoose.isValidObjectId))]
    .map((id) => new mongoose.Types.ObjectId(id));
  if (!ids.length) return posts.map((post) => ({ ...post, replyPostsCount: 0 }));

  const rows = await Post.aggregate([
    { $match: { replyTo: { $in: ids }, status: 'published' } },
    { $group: { _id: '$replyTo', count: { $sum: 1 } } }
  ]);
  const counts = new Map(rows.map((row) => [String(row._id), row.count]));
  return posts.map((post) => ({ ...post, replyPostsCount: counts.get(String(post._id)) || 0 }));
}

module.exports = { attachReplyPostCounts };
