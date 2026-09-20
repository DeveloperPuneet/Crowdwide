const mongoose = require('mongoose');
const User = require('../models/User');
const Post = require('../models/Post');
const Comment = require('../models/Comment');
const Community = require('../models/Community');
const { getRestrictedCommunityIds } = require('../utils/communityPrivacy');
const ranker = require('../utils/feedRanker');
const logger = require('./logger');

const DAY_MS = 24 * 60 * 60 * 1000;
const POOL_LIMIT = 96; // ranked posts kept per feed (6 pages of 16)
const FEED_CACHE_TTL_MS = 2 * 60 * 1000; // pages 2+ reuse the ranking of page 1
const FEED_REFRESH_AFTER_MS = 30 * 1000; // reloading page 1 re-ranks after this long
const PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;

const feedCache = new Map();
const profileCache = new Map();

const NOTES = {
  'for-you': 'Ranked for you: people you follow, your communities and interests - plus voices worth discovering.',
  'my-community': 'Posts from communities you have joined, with a few communities you might like.',
  'posts-new': 'Newest posts first. New voices get a head start.',
  'posts-viral': 'Posts gaining the most traction right now.',
  'articles-new': 'Newest articles first. New voices get a head start.',
  'articles-viral': 'Articles readers are engaging with the most.'
};

function remember(cache, key, value) {
  if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, value);
}

function clearFeedCache(userId) {
  if (!userId) return feedCache.clear();
  const prefix = `${userId}:`;
  Array.from(feedCache.keys()).filter((key) => key.startsWith(prefix)).forEach((key) => feedCache.delete(key));
  return undefined;
}

// Projection shared by every candidate query: only scoring fields and cheap
// counts, never the heavy arrays (likes, media, comments).
function candidateProjection() {
  const size = (path) => ({ $size: { $ifNull: [path, []] } });
  return {
    author: 1,
    community: 1,
    type: 1,
    hashtags: 1,
    createdAt: 1,
    status: 1,
    contentWarning: 1,
    moderationStatus: 1,
    moderationScore: 1,
    bodyLength: { $strLenCP: { $ifNull: ['$body', ''] } },
    hasMedia: { $gt: [size('$media'), 0] },
    counts: {
      likes: size('$likes'),
      comments: { $ifNull: ['$commentsCount', 0] },
      shares: { $ifNull: ['$sharesCount', 0] },
      views: { $ifNull: ['$viewsCount', 0] },
      reactions: { $add: [size('$reactions.celebrate'), size('$reactions.insightful'), size('$reactions.support'), size('$reactions.funny')] },
      pollVotes: { $reduce: { input: { $ifNull: ['$poll.options', []] }, initialValue: 0, in: { $add: ['$$value', size('$$this.votes')] } } }
    }
  };
}

// Same weights as ranker.engagementPoints, so "top engaged" in the database
// and the in-memory ranking agree.
const W = ranker.ENGAGEMENT_WEIGHTS;
const POINTS_EXPRESSION = {
  $add: [
    { $multiply: ['$counts.likes', W.likes] },
    { $multiply: ['$counts.reactions', W.reactions] },
    { $multiply: ['$counts.comments', W.comments] },
    { $multiply: ['$counts.shares', W.shares] },
    { $multiply: ['$counts.pollVotes', W.pollVotes] },
    { $multiply: ['$counts.views', W.views] }
  ]
};

// NOTE: Query#distinct ignores sort()/limit(), so bounded id lists must use
// a normal find + select instead.
async function idsOf(query) {
  const rows = await query.select('_id').lean();
  return rows.map((row) => row._id);
}

function fetchRecent(match, limit) {
  return Post.aggregate([{ $match: match }, { $sort: { createdAt: -1 } }, { $limit: limit }, { $project: candidateProjection() }]);
}

function fetchMostEngaged(match, limit) {
  return Post.aggregate([
    { $match: match },
    { $project: candidateProjection() },
    { $addFields: { points: POINTS_EXPRESSION } },
    { $sort: { points: -1, createdAt: -1 } },
    { $limit: limit }
  ]);
}

async function loadUser(userId) {
  return User.findById(userId).select('following joinedCommunities blockedUsers mutedUsers bookmarks hashtags searchHistory createdAt').lean();
}

// What this person is interested in, learned from what they actually do:
// likes, comments, saves, their own posts, profile/community hashtags and
// recent searches. Cached briefly - it changes slowly and costs a handful of
// queries.
async function getInterestProfile(user) {
  const key = String(user._id);
  const cached = profileCache.get(key);
  if (cached && Date.now() - cached.at < PROFILE_CACHE_TTL_MS) return cached.value;

  const joined = user.joinedCommunities || [];
  const bookmarkIds = (user.bookmarks || []).slice(-40);
  const [liked, ownPosts, commentRows, saved, communities] = await Promise.all([
    Post.find({ likes: user._id, status: 'published' }).sort({ createdAt: -1 }).limit(60).select('hashtags author').lean(),
    Post.find({ author: user._id, status: 'published' }).sort({ createdAt: -1 }).limit(30).select('hashtags').lean(),
    Comment.find({ author: user._id }).sort({ createdAt: -1 }).limit(40).select('post').lean(),
    bookmarkIds.length ? Post.find({ _id: { $in: bookmarkIds } }).select('hashtags author').lean() : [],
    joined.length ? Community.find({ _id: { $in: joined } }).select('hashtags').lean() : []
  ]);
  const commented = commentRows.length ? await Post.find({ _id: { $in: commentRows.map((row) => row.post) } }).select('hashtags author').lean() : [];

  const searchTags = (user.searchHistory || []).slice(0, 10).flatMap((entry) => String(entry.query || '').toLowerCase().replace(/^#/, '').split(/[^a-z0-9_]+/).filter((word) => word.length >= 3));
  const interests = ranker.buildInterestMap([
    { tags: user.hashtags || [], weight: 3 },
    ...liked.map((post) => ({ tags: post.hashtags || [], weight: 1 })),
    ...saved.map((post) => ({ tags: post.hashtags || [], weight: 2.5 })),
    ...commented.map((post) => ({ tags: post.hashtags || [], weight: 2 })),
    ...ownPosts.map((post) => ({ tags: post.hashtags || [], weight: 1.5 })),
    ...communities.map((community) => ({ tags: community.hashtags || [], weight: 1.5 })),
    { tags: searchTags, weight: 1.2 }
  ]);

  const rawAffinity = new Map();
  const addAffinity = (posts, weight) => posts.forEach((post) => {
    const author = String(post.author);
    rawAffinity.set(author, (rawAffinity.get(author) || 0) + weight);
  });
  addAffinity(liked, 1);
  addAffinity(commented, 2);
  addAffinity(saved, 2);
  const maxAffinity = Math.max(0, ...rawAffinity.values());
  const authorAffinity = new Map(Array.from(rawAffinity, ([author, value]) => [author, maxAffinity ? Math.sqrt(value / maxAffinity) : 0]));

  const value = { interests, authorAffinity };
  remember(profileCache, key, { at: Date.now(), value });
  return value;
}

function topInterestTags(interests, count = 12) {
  return Array.from(interests).sort((a, b) => b[1] - a[1]).slice(0, count).map(([tag]) => tag);
}

function typeFilter(view) {
  const types = ranker.TAB_CONFIG[view].types;
  return types ? { type: { $in: types } } : {};
}

// Collects candidate posts for a view. Every query is bounded and uses the
// status/createdAt indexes, so the cost stays flat as the platform grows.
async function gatherCandidates({ user, view, restricted, excludedAuthors, interests, now }) {
  const following = user.following || [];
  const joined = user.joinedCommunities || [];
  const base = {
    status: 'published',
    community: { $nin: restricted },
    author: { $nin: excludedAuthors },
    moderationStatus: { $ne: 'reported' },
    ...typeFilter(view)
  };
  const since = (days) => ({ createdAt: { $gte: new Date(now - days * DAY_MS) } });
  const lists = [];
  let extendedIds = [];

  if (view === 'for-you') {
    const tags = topInterestTags(interests);
    const [followedFollowing, newAuthors, smallCommunities] = await Promise.all([
      following.length ? User.find({ _id: { $in: following.slice(0, 200) } }).distinct('following') : [],
      idsOf(User.find({ isVerified: true, createdAt: { $gte: new Date(now - 45 * DAY_MS) } }).sort({ createdAt: -1 }).limit(100)),
      idsOf(Community.find({ isPrivate: false, membersCount: { $lte: 25 } }).sort({ createdAt: -1 }).limit(30))
    ]);
    const followingSet = new Set(following.map(String));
    extendedIds = followedFollowing.filter((id) => String(id) !== String(user._id) && !followingSet.has(String(id))).slice(0, 150);
    lists.push(
      following.length ? fetchRecent({ ...base, author: { $in: following.filter((id) => !excludedAuthors.some((blocked) => String(blocked) === String(id))) }, ...since(30) }, 80) : [],
      joined.length ? fetchRecent({ ...base, community: { $in: joined }, ...since(30) }, 80) : [],
      tags.length ? fetchRecent({ ...base, hashtags: { $in: tags }, ...since(21) }, 80) : [],
      extendedIds.length ? fetchRecent({ ...base, author: { $in: extendedIds, $nin: excludedAuthors }, ...since(21) }, 40) : [],
      fetchMostEngaged({ ...base, ...since(7) }, 60),
      newAuthors.length ? fetchRecent({ ...base, author: { $in: newAuthors, $nin: excludedAuthors }, ...since(21) }, 50) : [],
      smallCommunities.length ? fetchRecent({ ...base, community: { $in: smallCommunities, $nin: restricted }, ...since(30) }, 40) : [],
      fetchRecent({ ...base, ...since(7) }, 60),
      fetchRecent({ status: 'published', author: user._id, community: { $nin: restricted }, ...typeFilter(view), createdAt: { $gte: new Date(now - 3 * 60 * 60 * 1000) } }, 3)
    );
  } else if (view === 'my-community') {
    const tags = topInterestTags(interests);
    const [interestCommunities, smallCommunities, bigCommunities] = await Promise.all([
      tags.length ? idsOf(Community.find({ isPrivate: false, _id: { $nin: joined }, hashtags: { $in: tags } }).limit(20)) : [],
      idsOf(Community.find({ isPrivate: false, _id: { $nin: joined } }).sort({ createdAt: -1 }).limit(20)),
      idsOf(Community.find({ isPrivate: false, _id: { $nin: joined } }).sort({ membersCount: -1 }).limit(10))
    ]);
    const suggested = Array.from(new Set([...interestCommunities, ...smallCommunities, ...bigCommunities].map(String))).map((id) => new mongoose.Types.ObjectId(id));
    lists.push(
      joined.length ? fetchRecent({ ...base, community: { $in: joined }, ...since(45) }, 120) : [],
      suggested.length ? fetchRecent({ ...base, community: { $in: suggested }, ...since(45) }, 80) : []
    );
  } else if (view.endsWith('-new')) {
    lists.push(
      fetchRecent({ ...base, ...since(60) }, 120),
      following.length ? fetchRecent({ ...base, author: { $in: following, $nin: excludedAuthors }, ...since(60) }, 40) : [],
      joined.length ? fetchRecent({ ...base, community: { $in: joined }, ...since(60) }, 40) : []
    );
  } else {
    // Viral: widen the window when the platform is quiet.
    let engaged = await fetchMostEngaged({ ...base, ...since(14) }, 120);
    if (engaged.length < ranker.PAGE_SIZE * 2) engaged = await fetchMostEngaged({ ...base, ...since(90) }, 120);
    lists.push(engaged);
  }

  const results = await Promise.all(lists);
  return { candidates: results.flat(), extendedIds };
}

async function loadAuthorAndCommunityInfo(candidates, now) {
  const authorIds = Array.from(new Set(candidates.map((post) => String(post.author)))).map((id) => new mongoose.Types.ObjectId(id));
  const communityIds = Array.from(new Set(candidates.filter((post) => post.community).map((post) => String(post.community)))).map((id) => new mongoose.Types.ObjectId(id));
  const [authors, followerRows, communities] = await Promise.all([
    authorIds.length ? User.find({ _id: { $in: authorIds } }).select('createdAt').lean() : [],
    authorIds.length ? User.aggregate([{ $match: { following: { $in: authorIds } } }, { $unwind: '$following' }, { $match: { following: { $in: authorIds } } }, { $group: { _id: '$following', followers: { $sum: 1 } } }]) : [],
    communityIds.length ? Community.find({ _id: { $in: communityIds } }).select('membersCount').lean() : []
  ]);
  const followers = new Map(followerRows.map((row) => [String(row._id), row.followers]));
  return {
    authors: new Map(authors.map((author) => [String(author._id), { ageDays: (now - new Date(author.createdAt).getTime()) / DAY_MS, followers: followers.get(String(author._id)) || 0 }])),
    communityMembers: new Map(communities.map((community) => [String(community._id), community.membersCount || 0]))
  };
}

async function buildRanking({ user, view, now }) {
  const [restricted, profile] = await Promise.all([getRestrictedCommunityIds(user._id), getInterestProfile(user)]);
  const excludedAuthors = [...(user.blockedUsers || []), ...(user.mutedUsers || [])];
  const { candidates, extendedIds } = await gatherCandidates({ user, view, restricted, excludedAuthors, interests: profile.interests, now });
  const info = await loadAuthorAndCommunityInfo(candidates, now);
  const ranked = ranker.rankFeed(candidates, {
    userId: String(user._id),
    now,
    following: new Set((user.following || []).map(String)),
    joined: new Set((user.joinedCommunities || []).map(String)),
    extended: new Set(extendedIds.map(String)),
    interests: profile.interests,
    authorAffinity: profile.authorAffinity,
    authors: info.authors,
    communityMembers: info.communityMembers,
    discoveryRatio: process.env.FEED_DISCOVERY_RATIO
  }, view, { limit: POOL_LIMIT });
  return ranked.map((item) => ({ id: String(item.post._id), source: item.source, lane: item.lane }));
}

async function loadPagePosts(entries, user) {
  if (!entries.length) return [];
  const ids = entries.map((entry) => entry.id);
  const docs = await Post.find({ _id: { $in: ids } }).lean();
  const byId = new Map(docs.map((doc) => [String(doc._id), doc]));
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
  const populated = await Post.populate(ordered, [
    { path: 'author', select: 'name createdAt profilePicture' },
    { path: 'community', select: 'name slug membersCount' },
    { path: 'quotedPost', select: 'body author', populate: { path: 'author', select: 'name profilePicture' } },
    { path: 'replyTo', select: 'body author', populate: { path: 'author', select: 'name profilePicture' } }
  ]);
  const sources = new Map(entries.map((entry) => [entry.id, entry.source]));
  const bookmarked = new Set((user.bookmarks || []).map(String));
  const me = String(user._id);
  return populated
    .filter((post) => post.author)
    .map((post) => ({
      ...post,
      feedSource: sources.get(String(post._id)),
      liked: (post.likes || []).some((id) => String(id) === me),
      bookmarked: bookmarked.has(String(post._id))
    }));
}

// The viewer's own drafts / scheduled / awaiting-review posts stay pinned to
// the top of "For you" so they can see what is queued.
async function loadOwnPending(user) {
  const rows = await Post.find({ author: user._id, status: { $in: ['draft', 'scheduled', 'pending'] } }).sort({ createdAt: -1 }).limit(3).lean();
  return rows.map((post) => ({ id: String(post._id), source: post.status === 'draft' ? 'Draft' : post.status === 'scheduled' ? 'Scheduled' : 'Awaiting community review' }));
}

async function recencyFallback({ user, view }) {
  const restricted = await getRestrictedCommunityIds(user._id);
  const posts = await Post.find({
    status: 'published',
    community: { $nin: restricted },
    author: { $nin: [...(user.blockedUsers || []), ...(user.mutedUsers || [])] },
    ...typeFilter(view)
  }).sort({ createdAt: -1 }).limit(ranker.PAGE_SIZE * 3).select('_id').lean();
  return posts.map((post) => ({ id: String(post._id), source: 'Fresh from Crowdwide', lane: 'discovery' }));
}

async function getFeedPage({ userId, view = 'for-you', page = 1, now = Date.now(), force = false, user: preloaded = null }) {
  const tab = ranker.isFeedTab(view) ? view : 'for-you';
  const pageNumber = Math.max(1, Number.parseInt(page, 10) || 1);
  const user = preloaded || await loadUser(userId);
  if (!user) return { posts: [], hasMore: false, page: pageNumber, view: tab, note: NOTES[tab], discoveryRatio: 0 };

  const key = `${userId}:${tab}`;
  const cached = feedCache.get(key);
  const age = cached ? now - cached.at : Infinity;
  const reuse = cached && !force && age < FEED_CACHE_TTL_MS && (pageNumber > 1 || age < FEED_REFRESH_AFTER_MS);
  let entries;
  if (reuse) entries = cached.entries;
  else {
    try {
      entries = await buildRanking({ user, view: tab, now });
    } catch (error) {
      // Ranking is an enhancement: if it fails (e.g. a slow database), fall
      // back to plain newest-first so the page still loads.
      logger.error('Feed ranking failed; falling back to newest-first', error);
      entries = await recencyFallback({ user, view: tab });
    }
    remember(feedCache, key, { at: now, entries });
  }

  const start = (pageNumber - 1) * ranker.PAGE_SIZE;
  const slice = entries.slice(start, start + ranker.PAGE_SIZE);
  const pending = tab === 'for-you' && pageNumber === 1 ? await loadOwnPending(user) : [];
  const posts = await loadPagePosts([...pending, ...slice], user);
  const discoveryShown = slice.filter((entry) => entry.lane === 'discovery').length;
  return {
    posts,
    hasMore: start + ranker.PAGE_SIZE < entries.length,
    page: pageNumber,
    view: tab,
    note: NOTES[tab],
    discoveryShare: slice.length ? discoveryShown / slice.length : 0
  };
}

module.exports = { getFeedPage, getInterestProfile, clearFeedCache, buildRanking, candidateProjection, POOL_LIMIT, NOTES };
