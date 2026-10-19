// Posting streaks and badges.
//
// A streak is the number of consecutive days, on the member's own clock, on
// which they published a post or left a comment. Missing a day ends it. Badges
// are awarded for milestones (first post, 7-day streak, ...) and announced with
// a notification. A gentle "save your streak" push goes only to members who
// opted into push, only once a day, only when a streak of 3+ days is at risk.
const User = require('../models/User');
const Post = require('../models/Post');
const Comment = require('../models/Comment');
const Notification = require('../models/Notification');
const { badgeInfo, badgesFor } = require('../utils/badges');
const { QUESTION_TAG } = require('../utils/questions');
const { localClock, isValidTimezone } = require('./newsletterWorker');
const { sendPushToUser } = require('./push');
const logger = require('./logger');

const DAY_MS = 24 * 60 * 60 * 1000;
const defaultZone = () => (isValidTimezone(process.env.NEWSLETTER_TIMEZONE) ? process.env.NEWSLETTER_TIMEZONE : 'Asia/Kolkata');
const zoneOf = (user) => (isValidTimezone(user?.timezone) ? user.timezone : defaultZone());

const dayFormatters = new Map();
// Calendar day ("2026-10-19") of `date` on the wall clock in `zone`.
function dayKey(date, zone) {
  let formatter = dayFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFormatters.set(zone, formatter);
  }
  return formatter.format(date);
}

function previousDayKey(key) {
  return new Date(Date.parse(`${key}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
}

// The streak to SHOW: a streak whose last day is today or yesterday is still
// alive (they have until the end of today to extend it); anything older is over.
function effectiveStreak(streak = {}, now = new Date(), zone = defaultZone()) {
  const today = dayKey(now, zone);
  const last = streak.lastDay || '';
  const alive = last === today || last === previousDayKey(today);
  return {
    current: alive ? streak.current || 0 : 0,
    longest: streak.longest || 0,
    doneToday: last === today,
    atRisk: alive && last !== today && (streak.current || 0) > 0
  };
}

// What the streak becomes after a contribution on `today` (pure).
function nextStreak(streak = {}, today) {
  const last = streak.lastDay || '';
  if (last === today) return { current: streak.current || 1, longest: Math.max(streak.longest || 0, streak.current || 1), lastDay: today, changed: false };
  const current = last === previousDayKey(today) ? (streak.current || 0) + 1 : 1;
  return { current, longest: Math.max(streak.longest || 0, current), lastDay: today, changed: true };
}

async function awardBadges(userId, keys, owned = []) {
  const earned = [];
  for (const key of keys) {
    if (owned.includes(key) || !badgeInfo(key)) continue;
    const result = await User.updateOne({ _id: userId, 'badges.key': { $ne: key } }, { $push: { badges: { key, earnedAt: new Date() } } });
    if (!result.modifiedCount) continue;
    earned.push(key);
    const info = badgeInfo(key);
    await Notification.create({ recipient: userId, type: 'badge', message: `You earned the "${info.name}" badge. ${info.description}`, url: `/u/${userId}` }).catch((error) => logger.warn('Badge notification failed', error));
  }
  return earned;
}

// Call after a member publishes a post/reply-post (kind "post") or comments
// (kind "comment"). Never throws; failures only lose a streak tick.
async function recordContribution(userId, { kind = 'post', hashtags = [], now = new Date() } = {}) {
  try {
    const user = await User.findById(userId).select('timezone streak badges').lean();
    if (!user) return null;
    const zone = zoneOf(user);
    const today = dayKey(now, zone);
    const next = nextStreak(user.streak, today);
    if (next.changed) {
      await User.updateOne({ _id: userId, 'streak.lastDay': user.streak?.lastDay || '' }, { $set: { 'streak.current': next.current, 'streak.longest': next.longest, 'streak.lastDay': today } });
    }
    const owned = (user.badges || []).map((badge) => badge.key);
    const [posts, comments] = await Promise.all([
      kind === 'post' ? Post.countDocuments({ author: userId, status: 'published' }) : null,
      kind === 'comment' ? Comment.countDocuments({ author: userId }) : null
    ]);
    const keys = badgesFor({ streak: next.current, posts, comments, answeredQotd: kind === 'post' && (hashtags || []).includes(QUESTION_TAG) });
    const earned = await awardBadges(userId, keys, owned);
    return { streak: next.current, earned };
  } catch (error) {
    logger.warn('Could not record streak/badges', error);
    return null;
  }
}

// "Save your streak": push only, once per day, local evening, streak >= 3 that is
// still alive but has not been extended today.
async function sendStreakSavers({ now = new Date(), limit = 100 } = {}) {
  const result = { checked: 0, sent: 0 };
  const candidates = await User.find({
    isVerified: true,
    pushNotificationsEnabled: true,
    'notificationPreferences.emailReminders': { $ne: false },
    'streak.current': { $gte: 3 }
  }).select('_id timezone streak').limit(500).lean();
  for (const user of candidates) {
    if (result.sent >= limit) break;
    const zone = zoneOf(user);
    const { minutes } = localClock(now, zone);
    if (minutes < 18 * 60 || minutes >= 21 * 60) continue;
    result.checked += 1;
    const today = dayKey(now, zone);
    const state = effectiveStreak(user.streak, now, zone);
    if (!state.atRisk || user.streak?.saverSentDay === today) continue;
    const claim = await User.updateOne({ _id: user._id, 'streak.saverSentDay': { $ne: today } }, { $set: { 'streak.saverSentDay': today } });
    if (!claim.modifiedCount) continue;
    await sendPushToUser(user._id, { title: 'Crowdwide', body: `Your ${state.current}-day streak ends tonight. A quick comment or post keeps it going.`, url: '/dashboard?ask=qotd' })
      .catch((error) => logger.warn('Streak saver push failed', error));
    result.sent += 1;
  }
  return result;
}

module.exports = { zoneOf, dayKey, previousDayKey, effectiveStreak, nextStreak, awardBadges, recordContribution, sendStreakSavers };
