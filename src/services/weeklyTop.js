// "This week on Crowdwide": the best of the last seven days, built only from
// content that is already public (no private or members-only communities, no
// reported posts, no followers-only profiles), cached for a few minutes. Powers
// the shareable /top page.
const Post = require('../models/Post');
const { getRestrictedCommunityIds } = require('../utils/communityPrivacy');
const logger = require('./logger');

const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = 10 * 60 * 1000;
let cache = null;

function engagement(post) {
  const reactions = Object.values(post.reactions || {}).reduce((total, users) => total + (users?.length || 0), 0);
  const votes = (post.poll?.options || []).reduce((total, option) => total + (option.votes?.length || 0), 0);
  return (post.likes?.length || 0) + reactions * 1.5 + (post.commentsCount || 0) * 3 + (post.sharesCount || 0) * 4 + votes * 1.2 + (post.viewsCount || 0) * 0.05;
}

const idOf = (value) => String(value?._id || value || '');

// Pure ranking so it can be tested without a database.
function rankWeekly(posts = [], { now = Date.now() } = {}) {
  const eligible = posts.filter((post) => post.author && post.author.privacy !== 'followers' && !post.replyTo);
  const scored = eligible.map((post) => ({ post, score: engagement(post) })).sort((a, b) => b.score - a.score || new Date(b.post.createdAt) - new Date(a.post.createdAt));
  const used = new Set();
  const take = (list, limit) => {
    const picked = [];
    for (const entry of list) {
      if (used.has(idOf(entry.post))) continue;
      used.add(idOf(entry.post));
      picked.push(entry.post);
      if (picked.length === limit) break;
    }
    return picked;
  };
  const articles = take(scored.filter(({ post }) => post.type === 'article'), 3);
  const discussed = take(scored.filter(({ post }) => (post.commentsCount || 0) >= 2).sort((a, b) => (b.post.commentsCount || 0) - (a.post.commentsCount || 0)), 3);
  const top = take(scored, 6);

  const creators = new Map();
  const communities = new Map();
  eligible.forEach((post) => {
    const score = engagement(post);
    const authorId = idOf(post.author);
    const creator = creators.get(authorId) || { author: post.author, posts: 0, score: 0 };
    creator.posts += 1; creator.score += score;
    creators.set(authorId, creator);
    if (post.community && !post.community.isPrivate) {
      const key = idOf(post.community);
      const community = communities.get(key) || { community: post.community, posts: 0, score: 0 };
      community.posts += 1; community.score += score;
      communities.set(key, community);
    }
  });
  const byScore = (a, b) => b.score - a.score || b.posts - a.posts;
  return {
    top, articles, discussed,
    creators: [...creators.values()].sort(byScore).slice(0, 5),
    communities: [...communities.values()].sort(byScore).slice(0, 5),
    totals: { posts: eligible.length, members: creators.size, communities: communities.size },
    from: new Date(now - 7 * DAY_MS),
    to: new Date(now)
  };
}

async function getWeeklyTop({ now = Date.now(), force = false } = {}) {
  if (!force && cache && now - cache.at < CACHE_TTL_MS) return cache.data;
  const restricted = await getRestrictedCommunityIds(null);
  const posts = await Post.find({
    status: 'published',
    moderationStatus: { $ne: 'reported' },
    community: { $nin: restricted },
    replyTo: null,
    createdAt: { $gte: new Date(now - 7 * DAY_MS) }
  }).sort({ createdAt: -1 }).limit(400)
    .populate('author', 'name profilePicture privacy')
    .populate('coAuthors', 'name profilePicture')
    .populate('community', 'name slug isPrivate membersCount')
    .lean();
  const data = rankWeekly(posts, { now });
  cache = { at: now, data };
  return data;
}

function clearWeeklyTopCache() { cache = null; }

module.exports = { rankWeekly, getWeeklyTop, clearWeeklyTopCache, engagement };
