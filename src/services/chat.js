// Shared helpers for direct messages and group chats.

const Post = require('../models/Post');
const { getRestrictedCommunityIds } = require('../utils/communityPrivacy');

const PAGE_SIZE = 40;
const OBJECT_ID = /^[a-f\d]{24}$/i;

function isObjectId(value) {
  return typeof value === 'string' && OBJECT_ID.test(value);
}

function excerpt(text, max = 140) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

// Plain-text summary of a message (inbox rows, notifications).
function previewText(message) {
  if (!message) return '';
  if (message.body) return message.body;
  if (message.gif?.url) return 'Sent a GIF';
  if (message.sharedPost) return 'Shared a post';
  return '';
}

function buildPostPreview(post) {
  const image = (post.media || []).find((item) => item.kind === 'image');
  const label = post.type === 'article' ? 'Article' : post.type === 'poll' ? 'Poll' : 'Post';
  return {
    id: String(post._id),
    type: post.type,
    label,
    author: post.author?.name || 'Crowdwide member',
    excerpt: excerpt(post.poll?.question || post.body, 160),
    image: image ? (image.thumbnailUrl || image.url) : null
  };
}

// Adds `postPreview` to every message that carries a shared post. A post the
// viewer is not allowed to see (private community they are not in, draft,
// deleted) becomes { unavailable: true } so a chat can never leak it.
async function attachPostPreviews(messages, viewerId) {
  const ids = messages.filter((message) => message.sharedPost).map((message) => message.sharedPost);
  if (!ids.length) return messages;
  const restricted = await getRestrictedCommunityIds(viewerId);
  const posts = await Post.find({ _id: { $in: ids }, status: 'published', community: { $nin: restricted } })
    .select('author body type media poll.question createdAt')
    .populate('author', 'name')
    .lean();
  const byId = new Map(posts.map((post) => [String(post._id), buildPostPreview(post)]));
  messages.forEach((message) => {
    if (message.sharedPost) message.postPreview = byId.get(String(message.sharedPost)) || { unavailable: true };
  });
  return messages;
}

module.exports = { PAGE_SIZE, isObjectId, excerpt, previewText, buildPostPreview, attachPostPreviews };
