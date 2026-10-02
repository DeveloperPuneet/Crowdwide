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

// ---- message requests -----------------------------------------------------
// A DM thread is a "request" (shown separately, not an ordinary conversation)
// when the recipient has never sent a message in it and hasn't explicitly
// accepted or declined it. Replying auto-accepts; this only needs to track
// the explicit accept/decline decisions and whether the recipient has ever
// sent anything.
const NEW_DM_REQUEST_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_NEW_DM_REQUESTS_PER_WINDOW = 20;

// True when `viewer` has never sent `other` a message - i.e. `other` started
// this thread and it is still (from viewer's side) unaccepted/undeclined.
function isPendingRequest({ viewerHasSent, accepted, declined }) {
  return !viewerHasSent && !accepted && !declined;
}

// Rate-limits how many *brand-new* threads (first-ever message to someone
// the sender has never contacted before) a sender can start in a rolling
// window, so one account can't mass-DM strangers. Replies within an existing
// thread are never limited by this - only the first message to someone new.
async function tooManyNewDmRequests(Message, senderId) {
  const since = new Date(Date.now() - NEW_DM_REQUEST_WINDOW_MS);
  const [priorRecipients, recentRecipients] = await Promise.all([
    Message.distinct('recipient', { sender: senderId, createdAt: { $lt: since } }),
    Message.distinct('recipient', { sender: senderId, createdAt: { $gte: since } })
  ]);
  const priorSet = new Set(priorRecipients.map(String));
  const newCount = recentRecipients.filter((id) => !priorSet.has(String(id))).length;
  return newCount >= MAX_NEW_DM_REQUESTS_PER_WINDOW;
}

module.exports = { PAGE_SIZE, isObjectId, excerpt, previewText, buildPostPreview, attachPostPreviews, isPendingRequest, tooManyNewDmRequests, NEW_DM_REQUEST_WINDOW_MS, MAX_NEW_DM_REQUESTS_PER_WINDOW };
