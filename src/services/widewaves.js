const WideWave = require('../models/WideWave');
const Post = require('../models/Post');
const User = require('../models/User');
const { validateWideWaveName, normalizeWideWaveName } = require('../utils/widewaveName');
const { parseHashtagList } = require('../utils/hashtags');
const { getHiddenAuthorIds } = require('../utils/profilePrivacy');
const logger = require('./logger');

const MAX_CREATED_PER_DAY = 3;
const MAX_ACTIVE_PER_USER = 15;
const MAX_HASHTAGS = 8;
const TRENDING_DAYS = 7;
const TRENDING_TTL_MS = 5 * 60 * 1000;
const PERIODS = { week: 7, month: 30, year: 365, all: null };

class WideWaveError extends Error {}

const objectId = (value) => /^[a-f\d]{24}$/i.test(String(value || ''));
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cleanTags = (input) => parseHashtagList(Array.isArray(input) ? input.join(' ') : input).slice(0, MAX_HASHTAGS);
const cleanDescription = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 200);

let trendingCache = { at: 0, rows: [] };
const clearTrendingCache = () => { trendingCache = { at: 0, rows: [] }; };

async function recountWideWave(waveId) {
  const [count, last] = await Promise.all([
    Post.countDocuments({ widewave: waveId, status: 'published' }),
    Post.findOne({ widewave: waveId, status: 'published' }).sort({ createdAt: -1 }).select('createdAt').lean()
  ]);
  await WideWave.updateOne({ _id: waveId }, { $set: { postsCount: count, lastPostAt: last?.createdAt || null } });
  clearTrendingCache();
  return count;
}

async function createWideWave({ userId, name, description, hashtags }) {
  const checked = validateWideWaveName(name);
  if (!checked.ok) throw new WideWaveError(checked.error);
  const desc = cleanDescription(description);
  if (desc.length < 10) throw new WideWaveError('Add a short description (at least 10 characters) so people know what ww/' + checked.name + ' is about.');
  const tags = cleanTags(hashtags);
  if (!tags.length) throw new WideWaveError('Add at least one hashtag for this WideWave (for example: poetry, writing).');
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [today, active] = await Promise.all([
    WideWave.countDocuments({ creator: userId, createdAt: { $gte: since } }),
    WideWave.countDocuments({ creator: userId, status: 'active' })
  ]);
  if (today >= MAX_CREATED_PER_DAY) throw new WideWaveError(`You can create up to ${MAX_CREATED_PER_DAY} WideWaves a day. Try again tomorrow.`);
  if (active >= MAX_ACTIVE_PER_USER) throw new WideWaveError(`You already run ${MAX_ACTIVE_PER_USER} WideWaves. Delete one before creating another.`);
  try {
    const wave = await WideWave.create({ name: checked.name, description: desc, hashtags: tags, creator: userId });
    clearTrendingCache();
    return wave;
  } catch (error) {
    if (error?.code === 11000) throw new WideWaveError(`ww/${checked.name} is already taken. Choose another name.`);
    throw error;
  }
}

// The creator can change only the description and hashtags.
async function updateWideWave({ wave, userId, description, hashtags }) {
  if (!wave || wave.status !== 'active') throw new WideWaveError('That WideWave is not available.');
  if (String(wave.creator) !== String(userId)) throw new WideWaveError('Only the creator can edit this WideWave.');
  const desc = cleanDescription(description);
  if (desc.length < 10) throw new WideWaveError('Add a short description (at least 10 characters).');
  const tags = cleanTags(hashtags);
  if (!tags.length) throw new WideWaveError('Keep at least one hashtag.');
  wave.description = desc;
  wave.hashtags = tags;
  await wave.save();
  clearTrendingCache();
  return wave;
}

// Deleting a WideWave never deletes its posts: they become ordinary posts.
async function deleteWideWave({ wave, actorId, staff = false, reason = '' }) {
  if (!wave) throw new WideWaveError('That WideWave no longer exists.');
  if (!staff && String(wave.creator) !== String(actorId)) throw new WideWaveError('Only the creator can delete this WideWave.');
  const moved = await Post.updateMany({ widewave: wave._id }, { $set: { widewave: null } });
  if (staff) {
    // Keep the record so the name stays blocked after a moderator removes it.
    wave.status = 'removed';
    wave.removedBy = actorId;
    wave.removedReason = String(reason || '').trim().slice(0, 300);
    wave.postsCount = 0;
    await wave.save();
  } else {
    await WideWave.deleteOne({ _id: wave._id });
  }
  clearTrendingCache();
  return { moved: moved.modifiedCount ?? moved.nModified ?? 0 };
}

async function findActiveByName(name) {
  const normalized = normalizeWideWaveName(name);
  if (!/^[a-z0-9_]{3,30}$/.test(normalized)) return null;
  return WideWave.findOne({ name: normalized, status: 'active' });
}

// Trending = how much happened in the last week: more posts means more trending,
// with likes and comments adding weight. Cached for a few minutes.
async function trendingWideWaves({ limit = 10, now = Date.now() } = {}) {
  if (now - trendingCache.at < TRENDING_TTL_MS && trendingCache.rows.length >= limit) return trendingCache.rows.slice(0, limit);
  const since = new Date(now - TRENDING_DAYS * 86400000);
  const rows = await Post.aggregate([
    { $match: { widewave: { $ne: null }, status: 'published', createdAt: { $gte: since } } },
    { $group: { _id: '$widewave', posts: { $sum: 1 }, likes: { $sum: { $size: { $ifNull: ['$likes', []] } } }, comments: { $sum: { $ifNull: ['$commentsCount', 0] } } } },
    { $addFields: { score: { $add: [{ $multiply: ['$posts', 3] }, '$likes', { $multiply: ['$comments', 2] }] } } },
    { $sort: { score: -1 } },
    { $limit: Math.max(limit, 30) }
  ]);
  const waves = await WideWave.find({ _id: { $in: rows.map((row) => row._id) }, status: 'active' }).lean();
  const byId = new Map(waves.map((wave) => [String(wave._id), wave]));
  let result = rows.map((row) => byId.has(String(row._id)) ? { ...byId.get(String(row._id)), weekPosts: row.posts, score: row.score } : null).filter(Boolean);
  if (result.length < limit) {
    // Quiet week: top up with the biggest WideWaves overall so the list is never empty.
    const have = new Set(result.map((wave) => String(wave._id)));
    const extra = await WideWave.find({ status: 'active', _id: { $nin: [...have] } }).sort({ postsCount: -1, createdAt: -1 }).limit(limit - result.length).lean();
    result = [...result, ...extra.map((wave) => ({ ...wave, weekPosts: 0, score: 0 }))];
  }
  trendingCache = { at: now, rows: result };
  return result.slice(0, limit);
}

async function searchWideWaves(query, { limit = 12 } = {}) {
  const q = normalizeWideWaveName(query).slice(0, 60);
  if (!q) return trendingWideWaves({ limit });
  const safe = escapeRegex(q);
  return WideWave.find({
    status: 'active',
    $or: [{ name: new RegExp(`^${safe}`) }, { name: new RegExp(safe) }, { hashtags: q }, { description: new RegExp(safe, 'i') }]
  }).sort({ postsCount: -1 }).limit(limit).lean();
}

function interestOverlap(interests, tags) {
  let total = 0;
  tags.forEach((tag) => { total += Number(interests.get(String(tag).toLowerCase()) || 0); });
  return total;
}

// What the member is into, from the main feed's interest profile plus the WideWaves
// they post in or like posts from.
async function getWaveInterests(user) {
  const { getInterestProfile } = require('./feedService');
  const profile = await getInterestProfile(user);
  const [liked, mine] = await Promise.all([
    Post.find({ likes: user._id, widewave: { $ne: null }, status: 'published' }).sort({ createdAt: -1 }).limit(80).select('widewave').lean(),
    Post.find({ author: user._id, widewave: { $ne: null }, status: 'published' }).sort({ createdAt: -1 }).limit(40).select('widewave').lean()
  ]);
  const affinity = new Map();
  liked.forEach((post) => affinity.set(String(post.widewave), (affinity.get(String(post.widewave)) || 0) + 1));
  mine.forEach((post) => affinity.set(String(post.widewave), (affinity.get(String(post.widewave)) || 0) + 3));
  return { interests: profile.interests, affinity };
}

async function recommendWideWaves(user, { limit = 8 } = {}) {
  const [{ interests, affinity }, candidates, trending] = await Promise.all([
    getWaveInterests(user),
    WideWave.find({ status: 'active' }).sort({ postsCount: -1, createdAt: -1 }).limit(200).lean(),
    trendingWideWaves({ limit: 20 })
  ]);
  const trendRank = new Map(trending.map((wave, index) => [String(wave._id), 1 - index / 20]));
  const scored = candidates.map((wave) => {
    const interest = interestOverlap(interests, [...wave.hashtags, wave.name]);
    const score = interest * 2 + (affinity.get(String(wave._id)) || 0) * 1.5 + (trendRank.get(String(wave._id)) || 0) * 2 + Math.log10(1 + (wave.postsCount || 0)) * 0.5;
    return { wave, score, interest };
  }).sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ wave, interest }) => ({ ...wave, matchesInterests: interest > 0 }));
}

async function viewerFilters(user) {
  const hidden = await getHiddenAuthorIds(user?._id || null, user?.following || null);
  return { author: { $nin: [...(user?.blockedUsers || []), ...(user?.mutedUsers || []), ...hidden] } };
}

async function decoratePosts(posts, user) {
  const populated = await Post.populate(posts, [
    { path: 'author', select: 'name profilePicture' },
    { path: 'coAuthors', select: 'name profilePicture' },
    { path: 'widewave', select: 'name' },
    { path: 'quotedPost', select: 'body author', populate: { path: 'author', select: 'name profilePicture' } },
    { path: 'replyTo', select: 'body author', populate: { path: 'author', select: 'name profilePicture' } }
  ]);
  const uid = user ? String(user._id) : null;
  const saved = new Set((user?.bookmarks || []).map(String));
  return populated.map((post) => ({ ...post, liked: uid ? (post.likes || []).some((id) => String(id) === uid) : false, bookmarked: saved.has(String(post._id)), feedSource: post.widewave?.name ? `ww/${post.widewave.name}` : post.feedSource }));
}

const PAGE_SIZE = 15;

// Posts inside one WideWave: newest, or top (engagement over the last month).
async function wavePosts(wave, user, { sort = 'new', page = 1 } = {}) {
  const filter = { widewave: wave._id, status: 'published', moderationStatus: { $ne: 'reported' }, ...(await viewerFilters(user)) };
  const skip = (Math.max(1, page) - 1) * PAGE_SIZE;
  let posts;
  if (sort === 'top') {
    posts = await Post.aggregate([
      { $match: { ...filter, createdAt: { $gte: new Date(Date.now() - 30 * 86400000) } } },
      { $addFields: { engagement: { $add: [{ $size: { $ifNull: ['$likes', []] } }, { $multiply: [{ $ifNull: ['$commentsCount', 0] }, 2] }] } } },
      { $sort: { engagement: -1, createdAt: -1 } }, { $skip: skip }, { $limit: PAGE_SIZE + 1 }
    ]);
  } else {
    posts = await Post.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(PAGE_SIZE + 1).lean();
  }
  const hasMore = posts.length > PAGE_SIZE;
  return { posts: await decoratePosts(posts.slice(0, PAGE_SIZE), user), hasMore };
}

// "For you": posts from every WideWave, ranked by how well they match the member's
// interests, how engaging they are and how fresh they are. No joining needed.
async function recommendedWavePosts(user, { page = 1 } = {}) {
  const filter = { widewave: { $ne: null }, status: 'published', moderationStatus: { $ne: 'reported' }, createdAt: { $gte: new Date(Date.now() - 14 * 86400000) }, ...(await viewerFilters(user)) };
  const [candidates, waves, wi] = await Promise.all([
    Post.find(filter).sort({ createdAt: -1 }).limit(300).lean(),
    WideWave.find({ status: 'active' }).select('hashtags name').lean(),
    user ? getWaveInterests(user) : Promise.resolve({ interests: new Map(), affinity: new Map() })
  ]);
  const waveById = new Map(waves.map((wave) => [String(wave._id), wave]));
  const now = Date.now();
  const scored = candidates.filter((post) => waveById.has(String(post.widewave))).map((post) => {
    const wave = waveById.get(String(post.widewave));
    const interest = interestOverlap(wi.interests, [...(post.hashtags || []), ...wave.hashtags]);
    const engagement = (post.likes || []).length + (post.commentsCount || 0) * 2;
    const ageHours = (now - new Date(post.createdAt).getTime()) / 3600000;
    const fresh = 1 / (1 + ageHours / 24);
    const score = interest * 2 + (wi.affinity.get(String(post.widewave)) || 0) + Math.log2(1 + engagement) + fresh * 3 + (user && String(post.author) === String(user._id) ? -2 : 0);
    return { post, score };
  }).sort((a, b) => b.score - a.score);
  // At most two in a row from the same WideWave so one busy topic cannot take over.
  const spread = [];
  const pool = scored.map((entry) => entry.post);
  while (pool.length) {
    const last = spread.slice(-2).map((post) => String(post.widewave));
    const index = pool.findIndex((post) => !(last.length === 2 && last[0] === last[1] && last[1] === String(post.widewave)));
    spread.push(...pool.splice(index < 0 ? 0 : index, 1));
  }
  const skip = (Math.max(1, page) - 1) * PAGE_SIZE;
  const slice = spread.slice(skip, skip + PAGE_SIZE);
  return { posts: await decoratePosts(slice, user), hasMore: spread.length > skip + PAGE_SIZE };
}

function periodStart(period, now = Date.now()) {
  const days = PERIODS[period];
  return days ? new Date(now - days * 86400000) : null;
}

// Leaderboard: which WideWaves received the most posts this week / month / year / ever.
async function leaderboard(period = 'week', { limit = 20, now = Date.now() } = {}) {
  const key = Object.prototype.hasOwnProperty.call(PERIODS, period) ? period : 'week';
  const since = periodStart(key, now);
  const rows = await Post.aggregate([
    { $match: { widewave: { $ne: null }, status: 'published', ...(since ? { createdAt: { $gte: since } } : {}) } },
    { $group: { _id: '$widewave', posts: { $sum: 1 }, authors: { $addToSet: '$author' }, likes: { $sum: { $size: { $ifNull: ['$likes', []] } } } } },
    { $addFields: { writers: { $size: '$authors' } } },
    { $sort: { posts: -1, likes: -1 } },
    { $limit: limit * 2 }
  ]);
  const waves = await WideWave.find({ _id: { $in: rows.map((row) => row._id) }, status: 'active' }).lean();
  const byId = new Map(waves.map((wave) => [String(wave._id), wave]));
  return rows.map((row) => byId.has(String(row._id)) ? { ...byId.get(String(row._id)), periodPosts: row.posts, writers: row.writers, likes: row.likes } : null).filter(Boolean).slice(0, limit).map((wave, index) => ({ ...wave, rank: index + 1 }));
}

// Top contributors inside one WideWave for a period.
async function topContributors(wave, period = 'week', { limit = 5, now = Date.now() } = {}) {
  const since = periodStart(Object.prototype.hasOwnProperty.call(PERIODS, period) ? period : 'week', now);
  const rows = await Post.aggregate([
    { $match: { widewave: wave._id, status: 'published', ...(since ? { createdAt: { $gte: since } } : {}) } },
    { $group: { _id: '$author', posts: { $sum: 1 } } },
    { $sort: { posts: -1 } }, { $limit: limit }
  ]);
  const users = await User.find({ _id: { $in: rows.map((row) => row._id) }, privacy: { $ne: 'followers' } }).select('name profilePicture').lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  return rows.map((row) => byId.has(String(row._id)) ? { ...byId.get(String(row._id)), posts: row.posts } : null).filter(Boolean);
}

// Validates the WideWave picked in the composer; returns its id or throws.
async function resolveTargetForPost(name) {
  if (!name) return null;
  const wave = await findActiveByName(name);
  if (!wave) throw new WideWaveError('That WideWave does not exist any more. Pick another or post without one.');
  return wave;
}

async function weeklyDigest({ limit = 3 } = {}) {
  try {
    const rows = await trendingWideWaves({ limit });
    return rows.map((wave) => ({ name: wave.name, description: wave.description, weekPosts: wave.weekPosts || 0 }));
  } catch (error) {
    logger.error('Could not load WideWave digest', error);
    return [];
  }
}

module.exports = {
  WideWaveError, MAX_CREATED_PER_DAY, MAX_ACTIVE_PER_USER, PAGE_SIZE, PERIODS,
  createWideWave, updateWideWave, deleteWideWave, findActiveByName, trendingWideWaves, searchWideWaves,
  recommendWideWaves, recommendedWavePosts, wavePosts, leaderboard, topContributors, recountWideWave,
  resolveTargetForPost, weeklyDigest, clearTrendingCache, interestOverlap, periodStart, objectId
};
