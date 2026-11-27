const mongoose = require('mongoose');
const User = require('../models/User');
const Post = require('../models/Post');
const Comment = require('../models/Comment');
const Community = require('../models/Community');
const { getHiddenAuthorIds } = require('../utils/profilePrivacy');
const { getRestrictedCommunityIds } = require('../utils/communityPrivacy');
const { attachReplyPostCounts } = require('./replyPostCounts');
const { attachPollVoters } = require('./pollVoters');
const ranker = require('../utils/feedRanker');
const logger = require('./logger');
const { relatedInterestsFor, adjacentInterestsFor } = require('../utils/onboardingInterests');

const DAY_MS = 24 * 60 * 60 * 1000;
const POOL_LIMIT = 96; // ranked posts kept per feed (6 pages of 16)
const FEED_REFRESH_AFTER_MS = 30 * 1000; // reloading page 1 re-ranks after this long
const FEED_PAGINATION_TTL_MS = 10 * 60 * 1000; // scrolling to page 2+ keeps the order page 1 had, even after a slow read
const PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const MAX_INTERACTION_HISTORY = 200;
const MAX_EXPLORATION_HISTORY = 100;
const DEFAULT_INTERACTION_HALF_LIFE_DAYS = 30;
const INTERACTION_WEIGHTS = { likes: 1, reactions: 1.2, comments: 2, saves: 2.5, opens: 0.6, pollVotes: 1.5 };

function positiveConfig(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function interactionHalfLifeDays() {
  return positiveConfig(process.env.FEED_INTERACTION_HALF_LIFE_DAYS, DEFAULT_INTERACTION_HALF_LIFE_DAYS);
}

function explorationEvery() {
  return Math.max(1, Math.floor(positiveConfig(process.env.FEED_EXPLORE_EVERY, ranker.EXPLORE_EVERY)));
}

const feedCache = new Map();
const profileCache = new Map();

const NOTES = {
  'for-you': 'Ranked for you: people you follow, your communities and interests - plus voices worth discovering.',
  'my-community': 'Posts from communities you have joined, with a few communities you might like.',
  'posts-new': 'Newest posts first. New voices and small communities are always included.',
  'posts-viral': 'Posts people are liking, reacting to and discussing most - new voices count extra.',
  'articles-new': 'Newest articles first. New voices and small communities are always included.',
  'articles-viral': 'Articles readers are liking, reacting to and discussing most - new voices count extra.'
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

// The interest profile has its own cache (up to 5 minutes) separate from
// the ranked-feed cache above - clearing feedCache alone still left a like,
// follow, comment, etc. re-ranking the feed against a stale profile until
// that TTL passed. Clearing both together is what actually makes the "for
// you" feed react to what the person just did, not just to the clock.
function clearInterestProfile(userId) {
  if (userId) profileCache.delete(String(userId));
}

function clearAllFeedCaches() {
  const cleared = { feed: feedCache.size, interestProfiles: profileCache.size };
  feedCache.clear();
  profileCache.clear();
  return cleared;
}

function refreshPersonalization(userId) {
  clearFeedCache(userId);
  clearInterestProfile(userId);
}

function interactionWeight(type, occurredAt, now, halfLifeDays) {
  const key = {
    like: 'likes',
    reaction: 'reactions',
    comment: 'comments',
    save: 'saves',
    open: 'opens',
    pollVote: 'pollVotes'
  }[type];
  if (!key) return 0;
  const timestamp = occurredAt ? new Date(occurredAt).getTime() : now;
  const elapsedDays = Number.isFinite(timestamp) ? Math.max(0, (now - timestamp) / DAY_MS) : 0;
  return INTERACTION_WEIGHTS[key] * Math.pow(2, -elapsedDays / halfLifeDays);
}

function maximumSignalWeight(signals) {
  const totals = new Map();
  signals.forEach(({ tags = [], weight = 1 }) => {
    tags.forEach((tag) => {
      const key = String(tag || '').toLowerCase();
      if (key) totals.set(key, (totals.get(key) || 0) + weight);
    });
  });
  return Math.max(0, ...totals.values());
}

function buildBehaviorInterestProfile({
  interactions = [],
  liked = [],
  reacted = [],
  commented = [],
  saved = [],
  viewed = [],
  now = Date.now(),
  halfLifeDays = DEFAULT_INTERACTION_HALF_LIFE_DAYS
} = {}) {
  const sources = [
    { type: 'like', posts: liked },
    { type: 'reaction', posts: reacted },
    { type: 'comment', posts: commented },
    { type: 'save', posts: saved },
    { type: 'open', posts: viewed }
  ];
  const records = interactions.slice();
  sources.forEach(({ type, posts }) => posts.forEach((post) => {
    records.push({ type, occurredAt: post.interactionAt || post.createdAt, post });
  }));
  const signals = [];
  const baselineSignals = [];
  const evidence = new Map();
  const activity = { likes: 0, reactions: 0, comments: 0, saves: 0, opens: 0, pollVotes: 0 };
  const eventKey = { like: 'likes', reaction: 'reactions', comment: 'comments', save: 'saves', open: 'opens', pollVote: 'pollVotes' };

  records.forEach((record) => {
    const key = eventKey[record.type];
    if (!key) return;
    activity[key] += 1;
    const tags = Array.from(new Set((record.post?.hashtags || []).map((tag) => String(tag || '').toLowerCase()).filter(Boolean)));
    if (!tags.length) return;
    const weight = interactionWeight(record.type, record.occurredAt, now, halfLifeDays);
    if (!weight) return;
    signals.push({ tags, weight });
    baselineSignals.push({
      tags,
      weight: interactionWeight(record.type, now, now, halfLifeDays)
    });
    tags.forEach((tag) => {
      if (!evidence.has(tag)) evidence.set(tag, { likes: 0, reactions: 0, comments: 0, saves: 0, opens: 0, pollVotes: 0 });
      evidence.get(tag)[key] += 1;
    });
  });

  return {
    interests: ranker.buildInterestMap(signals, { normalizer: maximumSignalWeight(baselineSignals) }),
    evidence,
    activity,
    signals,
    baselineSignals,
    records
  };
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

// Viral eligibility and ordering use interactions only: a post that was merely
// opened a lot (views) is not "viral".
const INTERACTION_EXPRESSION = {
  $add: [
    { $multiply: ['$counts.likes', W.likes] },
    { $multiply: ['$counts.reactions', W.reactions] },
    { $multiply: ['$counts.comments', W.comments] },
    { $multiply: ['$counts.shares', W.shares] },
    { $multiply: ['$counts.pollVotes', W.pollVotes] }
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

function fetchMostEngaged(match, limit, minPoints = 0, { interactionsOnly = false } = {}) {
  return Post.aggregate([
    { $match: match },
    { $project: candidateProjection() },
    { $addFields: { points: interactionsOnly ? INTERACTION_EXPRESSION : POINTS_EXPRESSION } },
    ...(minPoints > 0 ? [{ $match: { points: { $gte: minPoints } } }] : []),
    { $sort: { points: -1, createdAt: -1 } },
    { $limit: limit }
  ]);
}

async function loadUser(userId) {
  return User.findById(userId).select('following joinedCommunities blockedUsers mutedUsers bookmarks hiddenPosts followedTopics followedDiscussions mutedDiscussions hashtags searchHistory createdAt recentViews interestInteractions explorationHistory adFreeUntil').lean();
}

// What this person is interested in, learned from what they actually do:
// likes, reactions, comments, saves, posts they opened, their own posts,
// profile/community hashtags and recent searches. Cached briefly - it
// changes slowly and costs a handful of queries.
async function getInterestProfile(user) {
  const key = String(user._id);
  const cached = profileCache.get(key);
  if (cached && Date.now() - cached.at < PROFILE_CACHE_TTL_MS) return cached.value;

  const now = Date.now();
  const halfLifeDays = interactionHalfLifeDays();
  const joined = user.joinedCommunities || [];
  const bookmarkIds = (user.bookmarks || []).slice(-40);
  // Most-recent-first already (see interactionController.postDetail); only
  // look at a recent slice so an old browsing kick doesn't dominate forever.
  const viewedIds = (user.recentViews || []).slice(0, 40).map((entry) => entry.post).filter(Boolean);
  const storedInteractions = Array.isArray(user.interestInteractions)
    ? user.interestInteractions
    : ((await User.findById(user._id).select('interestInteractions').lean())?.interestInteractions || []);
  const [liked, reacted, ownPosts, commentRows, saved, communities, viewed] = await Promise.all([
    Post.find({ likes: user._id, status: 'published' }).sort({ createdAt: -1 }).limit(60).select('hashtags author createdAt').lean(),
    Post.find({
      status: 'published',
      $or: [{ 'reactions.celebrate': user._id }, { 'reactions.insightful': user._id }, { 'reactions.support': user._id }, { 'reactions.funny': user._id }]
    }).sort({ createdAt: -1 }).limit(60).select('hashtags author createdAt').lean(),
    Post.find({ author: user._id, status: 'published' }).sort({ createdAt: -1 }).limit(30).select('hashtags').lean(),
    Comment.find({ author: user._id }).sort({ createdAt: -1 }).limit(40).select('post createdAt').lean(),
    bookmarkIds.length ? Post.find({ _id: { $in: bookmarkIds } }).select('hashtags author createdAt').lean() : [],
    joined.length ? Community.find({ _id: { $in: joined } }).select('hashtags').lean() : [],
    viewedIds.length ? Post.find({ _id: { $in: viewedIds } }).select('hashtags author createdAt').lean() : []
  ]);
  const commented = commentRows.length
    ? await Post.find({ _id: { $in: commentRows.map((row) => row.post) } }).select('hashtags author createdAt').lean()
    : [];
  const eventPostIds = Array.from(new Set(storedInteractions.map((entry) => String(entry.post)).filter(Boolean)));
  const eventPosts = eventPostIds.length
    ? await Post.find({ _id: { $in: eventPostIds } }).select('hashtags author createdAt').lean()
    : [];
  const postById = new Map([...liked, ...reacted, ...saved, ...viewed, ...commented, ...eventPosts]
    .map((post) => [String(post._id), post]));
  const interactionRecords = storedInteractions.flatMap((entry) => {
    const post = postById.get(String(entry.post));
    return post ? [{ type: entry.type, occurredAt: entry.occurredAt, post, explorationType: entry.explorationType }] : [];
  });
  const knownInteractions = new Set(interactionRecords.map((entry) => `${entry.type}:${entry.post._id}`));
  const addLegacy = (type, posts, dateFor) => posts.flatMap((post) => {
    const keyForPost = `${type}:${post._id}`;
    if (knownInteractions.has(keyForPost)) return [];
    knownInteractions.add(keyForPost);
    return [{ type, occurredAt: dateFor(post), post }];
  });
  const latestCommentAt = new Map();
  commentRows.forEach((row) => {
    const postId = String(row.post);
    if (!latestCommentAt.has(postId)) latestCommentAt.set(postId, row.createdAt);
  });
  const viewedAt = new Map((user.recentViews || []).map((entry) => [String(entry.post), entry.viewedAt]));
  const legacyInteractions = [
    ...addLegacy('like', liked, (post) => post.createdAt),
    ...addLegacy('reaction', reacted, (post) => post.createdAt),
    ...addLegacy('comment', commented, (post) => latestCommentAt.get(String(post._id)) || post.createdAt),
    ...addLegacy('save', saved, (post) => post.createdAt),
    ...addLegacy('open', viewed, (post) => viewedAt.get(String(post._id)) || post.createdAt)
  ];
  const behaviorProfile = buildBehaviorInterestProfile({
    interactions: [...interactionRecords, ...legacyInteractions],
    now,
    halfLifeDays
  });
  const searchTags = (user.searchHistory || []).slice(0, 10).flatMap((entry) => String(entry.query || '').toLowerCase().replace(/^#/, '').split(/[^a-z0-9_]+/).filter((word) => word.length >= 3));
  const stableSignals = [
    { tags: user.hashtags || [], weight: 3 },
    ...ownPosts.map((post) => ({ tags: post.hashtags || [], weight: 1.5 })),
    ...communities.map((community) => ({ tags: community.hashtags || [], weight: 1.5 })),
    { tags: searchTags, weight: 1.2 }
  ];
  const interests = ranker.buildInterestMap(
    [...stableSignals, ...behaviorProfile.signals],
    { normalizer: maximumSignalWeight([...stableSignals, ...behaviorProfile.baselineSignals]) }
  );

  const rawAffinity = new Map();
  const seenAuthors = new Set();
  behaviorProfile.records.forEach((record) => {
    const author = record.post?.author ? String(record.post.author) : null;
    if (!author) return;
    seenAuthors.add(author);
    const weight = interactionWeight(record.type, record.occurredAt, now, halfLifeDays);
    rawAffinity.set(author, (rawAffinity.get(author) || 0) + weight);
  });
  const maxAffinity = Math.max(0, ...rawAffinity.values());
  const authorAffinity = new Map(Array.from(rawAffinity, ([author, value]) => [author, maxAffinity ? Math.sqrt(value / maxAffinity) : 0]));

  const value = {
    interests,
    authorAffinity,
    seenAuthors,
    interactionRecords: behaviorProfile.records,
    behaviorInterests: behaviorProfile.interests,
    behaviorEvidence: behaviorProfile.evidence,
    behaviorActivity: behaviorProfile.activity
  };
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

// Under-exposed sources every tab should be able to surface: recently joined
// accounts and small public communities.
async function loadGrowthSources(now) {
  const [newAuthors, smallCommunities] = await Promise.all([
    idsOf(User.find({ isVerified: true, createdAt: { $gte: new Date(now - 45 * DAY_MS) } }).sort({ createdAt: -1 }).limit(100)),
    idsOf(Community.find({ isPrivate: false, membersCount: { $lte: 25 } }).sort({ createdAt: -1 }).limit(30))
  ]);
  return { newAuthors, smallCommunities };
}

// Collects candidate posts for a view. Every query is bounded and uses the
// status/createdAt indexes, so the cost stays flat as the platform grows.
async function gatherCandidates({ user, view, restricted, excludedAuthors, interests, now }) {
  const following = user.following || [];
  const joined = user.joinedCommunities || [];
  const hiddenPosts = user.hiddenPosts || [];
  const base = {
    status: 'published',
    _id: { $nin: hiddenPosts },
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
    const relatedTags = Array.from(relatedInterestsFor(tags));
    const adjacentTags = Array.from(adjacentInterestsFor(tags));
    const [followedFollowing, { newAuthors, smallCommunities }] = await Promise.all([
      following.length ? User.find({ _id: { $in: following.slice(0, 200) } }).distinct('following') : [],
      loadGrowthSources(now)
    ]);
    const followingSet = new Set(following.map(String));
    extendedIds = followedFollowing.filter((id) => String(id) !== String(user._id) && !followingSet.has(String(id))).slice(0, 150);
    lists.push(
      following.length ? fetchRecent({ ...base, author: { $in: following.filter((id) => !excludedAuthors.some((blocked) => String(blocked) === String(id))) }, ...since(30) }, 80) : [],
      joined.length ? fetchRecent({ ...base, community: { $in: joined }, ...since(30) }, 80) : [],
      tags.length ? fetchRecent({ ...base, hashtags: { $in: tags }, ...since(21) }, 80) : [],
      relatedTags.length ? fetchRecent({ ...base, hashtags: { $in: relatedTags }, ...since(21) }, 60) : [],
      adjacentTags.length ? fetchRecent({ ...base, hashtags: { $in: adjacentTags }, ...since(21) }, 40) : [],
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
    const { newAuthors, smallCommunities } = await loadGrowthSources(now);
    lists.push(
      fetchRecent({ ...base, ...since(60) }, 120),
      // Guarantees: a busy platform's newest 120 posts must not push out new
      // accounts or small communities.
      newAuthors.length ? fetchRecent({ ...base, author: { $in: newAuthors, $nin: excludedAuthors }, ...since(14) }, 40) : [],
      smallCommunities.length ? fetchRecent({ ...base, community: { $in: smallCommunities, $nin: restricted }, ...since(14) }, 40) : [],
      following.length ? fetchRecent({ ...base, author: { $in: following, $nin: excludedAuthors }, ...since(60) }, 40) : [],
      joined.length ? fetchRecent({ ...base, community: { $in: joined }, ...since(60) }, 40) : []
    );
  } else {
    // Viral: only posts with real traction; widen the window when the
    // platform is quiet (never by letting untouched posts in).
    const only = { interactionsOnly: true };
    const { newAuthors, smallCommunities } = await loadGrowthSources(now);
    let engaged = await fetchMostEngaged({ ...base, ...since(14) }, 120, ranker.MIN_VIRAL_POINTS, only);
    if (engaged.length < ranker.PAGE_SIZE * 2) engaged = await fetchMostEngaged({ ...base, ...since(90) }, 120, ranker.MIN_VIRAL_POINTS, only);
    lists.push(
      engaged,
      // Rising: small-reach posts that already have traction would never make
      // a global top-120 on a big platform, so they get their own lane.
      newAuthors.length ? fetchMostEngaged({ ...base, author: { $in: newAuthors, $nin: excludedAuthors }, ...since(21) }, 40, ranker.MIN_VIRAL_POINTS, only) : [],
      smallCommunities.length ? fetchMostEngaged({ ...base, community: { $in: smallCommunities, $nin: restricted }, ...since(21) }, 40, ranker.MIN_VIRAL_POINTS, only) : []
    );
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
  const excludedAuthors = [...(user.blockedUsers || []), ...(user.mutedUsers || []), ...(await getHiddenAuthorIds(user._id, user.following || []))];
  const { candidates, extendedIds } = await gatherCandidates({ user, view, restricted, excludedAuthors, interests: profile.interests, now });
  const info = await loadAuthorAndCommunityInfo(candidates, now);
  const topicInterests = topInterestTags(profile.interests);
  const ranked = ranker.rankFeed(candidates, {
    userId: String(user._id),
    now,
    following: new Set((user.following || []).map(String)),
    joined: new Set((user.joinedCommunities || []).map(String)),
    extended: new Set(extendedIds.map(String)),
    interests: profile.interests,
    authorAffinity: profile.authorAffinity,
    seenAuthors: profile.seenAuthors,
    exploredPosts: new Set((user.explorationHistory || []).map((entry) => String(entry.post))),
    relatedInterests: relatedInterestsFor(topicInterests),
    adjacentInterests: adjacentInterestsFor(topicInterests),
    exploreEvery: explorationEvery(),
    seen: new Set((user.recentViews || []).slice(0, 40).map((entry) => String(entry.post)).filter(Boolean)),
    authors: info.authors,
    communityMembers: info.communityMembers,
    discoveryRatio: process.env.FEED_DISCOVERY_RATIO
  }, view, { limit: POOL_LIMIT });
  return ranked.map((item) => ({
    id: String(item.post._id),
    source: item.source,
    lane: item.lane,
    ...(item.explore ? { explorationType: item.explorationType } : {})
  }));
}

async function recordInterestInteraction(userId, postId, type) {
  const user = await User.findById(userId).select('explorationHistory').lean();
  const exposure = (user?.explorationHistory || []).slice().reverse()
    .find((entry) => String(entry.post) === String(postId));
  const interaction = {
    post: postId,
    type,
    occurredAt: new Date(),
    ...(exposure ? { explorationType: exposure.type } : {})
  };
  await User.updateOne({ _id: userId }, {
    $push: { interestInteractions: { $each: [interaction], $slice: -MAX_INTERACTION_HISTORY } }
  });
  refreshPersonalization(userId);
}

async function removeInterestInteraction(userId, postId, type) {
  await User.updateOne({ _id: userId }, { $pull: { interestInteractions: { post: postId, type } } });
  refreshPersonalization(userId);
}

async function recordExplorationImpressions(userId, entries) {
  const impressions = entries.filter((entry) => entry.explorationType).map((entry) => ({
    post: entry.id,
    type: entry.explorationType,
    servedAt: new Date()
  }));
  if (!impressions.length) return;
  await User.updateOne({ _id: userId }, {
    $push: { explorationHistory: { $each: impressions, $slice: -MAX_EXPLORATION_HISTORY } }
  });
}

async function loadPagePosts(entries, user) {
  if (!entries.length) return [];
  const ids = entries.map((entry) => entry.id);
  const docs = await Post.find({ _id: { $in: ids } }).lean();
  const byId = new Map(docs.map((doc) => [String(doc._id), doc]));
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
  const populated = await Post.populate(ordered, [
    { path: 'author', select: 'name createdAt profilePicture' },
    { path: 'coAuthors', select: 'name profilePicture' },
    { path: 'community', select: 'name slug membersCount' },
    { path: 'quotedPost', select: 'body author', populate: { path: 'author', select: 'name profilePicture' } },
    { path: 'replyTo', select: 'body author', populate: { path: 'author', select: 'name profilePicture' } }
  ]);
  const sources = new Map(entries.map((entry) => [entry.id, entry.source]));
  const bookmarked = new Set((user.bookmarks || []).map(String));
  const me = String(user._id);
  const withReplyCounts = await attachPollVoters(await attachReplyPostCounts(populated), user._id);
  return withReplyCounts
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
  const hiddenAuthors = await getHiddenAuthorIds(user._id, user.following || []);
  const posts = await Post.find({
    status: 'published',
    community: { $nin: restricted },
    author: { $nin: [...(user.blockedUsers || []), ...(user.mutedUsers || []), ...hiddenAuthors] },
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
  const reuse = cached && !force && (pageNumber > 1 ? age < FEED_PAGINATION_TTL_MS : age < FEED_REFRESH_AFTER_MS);
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
  }
  if (!reuse) remember(feedCache, key, { at: now, entries });

  const start = (pageNumber - 1) * ranker.PAGE_SIZE;
  const organicSlice = entries.slice(start, start + ranker.PAGE_SIZE);
  const slice = organicSlice;
  const pending = tab === 'for-you' && pageNumber === 1 ? await loadOwnPending(user) : [];
  try {
    await recordExplorationImpressions(userId, slice);
  } catch (error) {
    logger.warn('Could not record feed exploration impressions', error);
  }
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

module.exports = {
  loadPagePosts,
  getFeedPage,
  getInterestProfile,
  topInterestTags,
  buildBehaviorInterestProfile,
  interactionWeight,
  recordInterestInteraction,
  removeInterestInteraction,
  clearFeedCache,
  clearInterestProfile,
  clearAllFeedCaches,
  refreshPersonalization,
  buildRanking,
  candidateProjection,
  POOL_LIMIT,
  NOTES,
  MAX_INTERACTION_HISTORY,
  MAX_EXPLORATION_HISTORY,
  DEFAULT_INTERACTION_HALF_LIFE_DAYS,
  INTERACTION_WEIGHTS
};
