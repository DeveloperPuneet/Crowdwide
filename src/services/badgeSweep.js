// Works out every badge a member qualifies for (not just the ones a new post or
// comment can unlock) and awards what is missing. Runs in three places:
//   - lazily, at most every 10 minutes per member, while they use the site;
//   - from the daily maintenance run, so badges also reach existing members
//     and anything a visit-based check would miss (account age, followers);
//   - right after the actions that matter (2FA on, profile saved, ...).
// Earning several at once sends ONE notification instead of a burst.
const User = require('../models/User');
const Post = require('../models/Post');
const Comment = require('../models/Comment');
const Community = require('../models/Community');
const Notification = require('../models/Notification');
const { badgesFor, badgeInfo, BADGES } = require('../utils/badges');
const { awardBadges } = require('./streaks');
const logger = require('./logger');

const DAY_MS = 24 * 60 * 60 * 1000;
const earlyLimit = () => Math.max(0, Number(process.env.EARLY_MEMBER_LIMIT) || 100);

const profileComplete = (user) => Boolean(user.profilePicture) && String(user.bio || '').trim().length > 0 && (user.hashtags || []).length >= 3;

// Everything measurable about a member that a badge can depend on.
async function collectFacts(userId, now = new Date()) {
  const user = await User.findById(userId).select('createdAt isVerified twoFactorEnabled profilePicture bio hashtags following joinedCommunities streak onboardingCompletedAt firstReplyAt').lean();
  if (!user) return null;
  const [byType, likes, hearts, followers, founded, earlierMembers] = await Promise.all([
    Post.aggregate([{ $match: { author: user._id, status: 'published' } }, { $group: { _id: '$type', total: { $sum: 1 } } }]),
    Post.aggregate([{ $match: { author: user._id, status: 'published' } }, { $group: { _id: null, total: { $sum: { $size: { $ifNull: ['$likes', []] } } } } }]),
    Comment.countDocuments({ author: user._id, heartedByAuthor: true }),
    User.countDocuments({ following: user._id }),
    Community.countDocuments({ owner: user._id }),
    User.countDocuments({ createdAt: { $lt: user.createdAt } })
  ]);
  const count = (type) => byType.find((row) => row._id === type)?.total || 0;
  const comments = await Comment.countDocuments({ author: user._id });
  return {
    verified: user.isVerified ? 1 : 0,
    onboarded: user.onboardingCompletedAt ? 1 : 0,
    profileComplete: profileComplete(user) ? 1 : 0,
    posts: byType.reduce((sum, row) => sum + row.total, 0),
    articles: count('article'),
    polls: count('poll'),
    comments,
    hearts,
    firstReply: user.firstReplyAt ? 1 : 0,
    streak: Math.max(user.streak?.longest || 0, user.streak?.current || 0),
    likes: likes[0]?.total || 0,
    followers,
    following: (user.following || []).length,
    communities: (user.joinedCommunities || []).length,
    founded,
    twoFactor: user.twoFactorEnabled ? 1 : 0,
    early: earlierMembers < earlyLimit() ? 1 : 0,
    accountDays: Math.floor((now.getTime() - new Date(user.createdAt).getTime()) / DAY_MS)
  };
}

// Awards whatever is missing. Returns { facts, earned }.
async function evaluateBadges(userId, { now = new Date() } = {}) {
  const facts = await collectFacts(userId, now);
  if (!facts) return { facts: null, earned: [] };
  const owned = ((await User.findById(userId).select('badges.key').lean())?.badges || []).map((badge) => badge.key);
  // The Question-of-the-Day badge is awarded when the post is made; nothing here can measure it.
  const keys = badgesFor(facts).filter((key) => !owned.includes(key));
  const earned = keys.length ? await awardBadges(userId, keys, owned, { notify: false }) : [];
  if (earned.length === 1) {
    const info = badgeInfo(earned[0]);
    await Notification.create({ recipient: userId, type: 'badge', badgeKey: earned[0], message: `You earned the "${info.name}" badge. ${info.description}`, url: '/badges' }).catch((error) => logger.warn('Badge notification failed', error));
  } else if (earned.length > 1) {
    const names = earned.map((key) => badgeInfo(key).name);
    const list = names.length > 4 ? `${names.slice(0, 4).join(', ')} and ${names.length - 4} more` : names.join(', ');
    await Notification.create({ recipient: userId, type: 'badge', badgeKey: earned[0], message: `You earned ${earned.length} new badges: ${list}.`, url: '/badges' }).catch((error) => logger.warn('Badge notification failed', error));
  }
  return { facts, earned };
}

// Lazy, throttled check used while someone browses. Never throws, never blocks.
const lastChecked = new Map();
const CHECK_EVERY_MS = 10 * 60 * 1000;
function maybeEvaluateBadges(userId, now = Date.now()) {
  const key = String(userId);
  if (now - (lastChecked.get(key) || 0) < CHECK_EVERY_MS) return;
  lastChecked.set(key, now);
  if (lastChecked.size > 5000) lastChecked.clear();
  evaluateBadges(userId).catch((error) => logger.warn('Badge check failed', error));
}
const forgetBadgeCheck = (userId) => lastChecked.delete(String(userId));

// Daily: every verified member active in the last 60 days, most recently active first.
async function sweepBadges({ limit = 1500, now = new Date() } = {}) {
  const members = await User.find({ isVerified: true, $or: [{ lastActiveAt: { $gte: new Date(now.getTime() - 60 * DAY_MS) } }, { lastActiveAt: { $exists: false } }] })
    .sort({ lastActiveAt: -1 }).limit(limit).select('_id').lean();
  let awarded = 0;
  let members_ = 0;
  for (const member of members) {
    try {
      const { earned } = await evaluateBadges(member._id, { now });
      awarded += earned.length;
      members_ += 1;
    } catch (error) {
      logger.warn('Badge sweep failed for one member', error);
    }
  }
  return { members: members_, awarded, totalBadges: BADGES.length };
}

module.exports = { collectFacts, evaluateBadges, maybeEvaluateBadges, forgetBadgeCheck, sweepBadges, profileComplete };
