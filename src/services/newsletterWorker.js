const cron = require('node-cron');
const User = require('../models/User');
const Post = require('../models/Post');
const { getInterestProfile } = require('./feedService');
const { interestScore, ageHours, hotValue } = require('../utils/feedRanker');
const { sendWeeklyNewsletter } = require('./mailer');
const { recommendWideWaves } = require('./widewaves');
const logger = require('./logger');

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
// The newsletter goes out on Sunday at 10:30 in EACH MEMBER'S OWN time zone.
// The worker therefore ticks every 15 minutes and, on each tick, sends to
// whoever's local clock is inside their Sunday window and who has not had one
// in the last six days. That also makes it self-healing: if the server was
// asleep or restarting at 10:30, the next tick before NEWSLETTER_CATCH_UP_MINUTES
// have passed still delivers it (a single weekly cron moment would just be lost).
const NEWSLETTER_CRON = '*/15 * * * *';
const NEWSLETTER_DAY = 'Sun';
const NEWSLETTER_LOCAL_MINUTE = 10 * 60 + 30; // 10:30
const NEWSLETTER_CATCH_UP_MINUTES = 12 * 60; // still deliver until 22:30 local
// Six days, not seven: run times drift by a few seconds, and with a strict
// seven-day gap a member who was sent last Sunday at 10:30:00.4 was skipped
// this Sunday when the tick happened at 10:30:00.1.
const MIN_GAP_MS = 6 * DAY_MS;
// Used for members whose browser has not told us a time zone yet.
const defaultTimezone = () => (isValidTimezone(process.env.NEWSLETTER_TIMEZONE) ? process.env.NEWSLETTER_TIMEZONE : 'Asia/Kolkata');

const formatters = new Map();
function isValidTimezone(zone) {
  if (typeof zone !== 'string' || !zone || zone.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch (error) { return false; }
}

// Weekday ("Sun") and minutes since midnight on the wall clock in `zone`.
function localClock(now, zone) {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formatters.set(zone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  return { weekday: parts.weekday, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

function isNewsletterWindow(now, zone) {
  const { weekday, minutes } = localClock(now, zone);
  return weekday === NEWSLETTER_DAY && minutes >= NEWSLETTER_LOCAL_MINUTE && minutes < NEWSLETTER_LOCAL_MINUTE + NEWSLETTER_CATCH_UP_MINUTES;
}

// Cheap guard so ticks outside the only hours in which Sunday 10:30-22:30 can
// be true anywhere on Earth (UTC-12 .. UTC+14) never touch the database.
function mayBeSundayWindowSomewhere(now) {
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  return (day === 6 && hour >= 18) || day === 0 || (day === 1 && hour < 12);
}

function engagement(post) {
  const reactions = Object.values(post.reactions || {}).reduce((total, users) => total + (users?.length || 0), 0);
  const votes = (post.poll?.options || []).reduce((total, option) => total + (option.votes?.length || 0), 0);
  return (post.likes?.length || 0) + reactions * 1.5 + (post.commentsCount || 0) * 3 + (post.sharesCount || 0) * 4 + votes * 1.2 + (post.viewsCount || 0) * 0.05;
}

function buildNewsletterSelection(posts, user, interests, now = Date.now(), authorAffinity = new Map()) {
  const sent = new Set((user.newsletterSentPosts || []).map(String));
  const joined = new Set((user.joinedCommunities || []).map(String));
  const available = posts.filter((post) => !sent.has(String(post._id))
    && String(post.author?._id || post.author) !== String(user._id)
    && (!post.community || !post.community.isPrivate || joined.has(String(post.community._id || post.community))));
  const selected = new Set();
  const take = (ranked, limit) => {
    const chosen = [];
    for (const post of ranked) {
      const id = String(post._id);
      if (selected.has(id)) continue;
      selected.add(id);
      chosen.push(post);
      if (chosen.length === limit) break;
    }
    return chosen;
  };
  const byFreshness = (a, b) => new Date(b.createdAt) - new Date(a.createdAt);
  const trendingScore = (post) => hotValue(engagement(post), ageHours(post.createdAt, now));
  const personalizedPosts = take(available
    .map((post) => {
      const authorId = String(post.author?._id || post.author);
      const tagScore = interestScore(post.hashtags || [], interests);
      const followed = (user.following || []).some((id) => String(id) === authorId);
      const authorScore = authorAffinity?.get?.(authorId) || 0;
      return { post, score: Math.max(tagScore, authorScore, followed ? 1 : 0) };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || engagement(b.post) - engagement(a.post) || byFreshness(a.post, b.post))
    .map(({ post }) => post), 10);

  const trendingPosts = take(available
    .filter((post) => new Date(post.createdAt).getTime() >= now - WEEK_MS)
    .sort((a, b) => trendingScore(b) - trendingScore(a) || byFreshness(a, b)), 5);

  const communityPosts = take(available
    .map((post) => {
      const communityId = String(post.community?._id || post.community || '');
      const joinedCommunity = communityId && joined.has(communityId);
      const tagScore = interestScore(post.hashtags || [], interests);
      return { post, score: (joinedCommunity ? 1 : 0) + tagScore };
    })
    .filter(({ post, score }) => post.community && score > 0)
    .sort((a, b) => b.score - a.score || engagement(b.post) - engagement(a.post) || byFreshness(a.post, b.post))
    .map(({ post }) => post), 5);

  return { personalizedPosts, trendingPosts, communityPosts };
}

async function sendWeeklyNewsletters({ now = new Date(), force = false } = {}) {
  const defaultZone = defaultTimezone();
  if (!force && !mayBeSundayWindowSomewhere(now)) return { eligible: 0, sent: 0, skippedNoPosts: 0 };
  const cutoff = new Date(now.getTime() - MIN_GAP_MS);
  const notRecentlySent = { $or: [{ newsletterLastSentAt: { $lte: cutoff } }, { newsletterLastSentAt: { $exists: false } }] };
  const base = { isVerified: true, 'notificationPreferences.emailNewsletter': { $ne: false } };

  // Which of the time zones our members actually use are inside their Sunday window right now?
  let zoneFilter = null;
  if (!force) {
    const zones = (await User.distinct('timezone', { ...base, ...notRecentlySent })).filter(Boolean);
    const dueZones = zones.filter((zone) => isValidTimezone(zone) && isNewsletterWindow(now, zone));
    const conditions = [];
    if (dueZones.length) conditions.push({ timezone: { $in: dueZones } });
    if (isNewsletterWindow(now, defaultZone)) {
      // No (or an unusable) saved zone -> the default zone decides.
      conditions.push({ timezone: { $in: [null, ''] } });
      const invalid = zones.filter((zone) => !isValidTimezone(zone));
      if (invalid.length) conditions.push({ timezone: { $in: invalid } });
    }
    if (!conditions.length) return { eligible: 0, sent: 0, skippedNoPosts: 0 };
    zoneFilter = { $or: conditions };
  }

  const users = await User.find({ ...base, $and: [notRecentlySent, ...(zoneFilter ? [zoneFilter] : [])] })
    .select('_id name email hashtags following joinedCommunities bookmarks searchHistory recentViews newsletterSentPosts newsletterLastSentAt').lean();
  if (!users.length) return { eligible: 0, sent: 0, skippedNoPosts: 0 };

  let sentCount = 0;
  let skippedNoPosts = 0;
  const posts = await Post.find({
    status: 'published',
    createdAt: { $gte: new Date(now.getTime() - 30 * DAY_MS) },
    moderationStatus: { $ne: 'reported' }
  }).sort({ createdAt: -1 }).limit(500)
    .populate('author', 'name')
    .populate('community', 'name slug isPrivate hashtags')
    .lean();

  for (const user of users) {
    if (!posts.length) { skippedNoPosts += 1; continue; }

    const interestProfile = await getInterestProfile(user);
    const { personalizedPosts, trendingPosts, communityPosts } = buildNewsletterSelection(
      posts, user, interestProfile.interests, now.getTime(), interestProfile.authorAffinity
    );
    const selected = [...personalizedPosts, ...trendingPosts, ...communityPosts];
    // Nothing new for this person (every candidate was already sent, is their
    // own, or is private): no email. They are retried on the next tick, so a
    // fresh post later the same Sunday still reaches them.
    if (!selected.length) { skippedNoPosts += 1; continue; }
    const claim = await User.updateOne({ _id: user._id, ...base, ...notRecentlySent }, { $set: { newsletterLastSentAt: now } });
    if (!claim.modifiedCount) continue;
    const widewaves = await recommendWideWaves(user, { limit: 3 }).catch(() => []);
    const delivered = await sendWeeklyNewsletter(user, { personalizedPosts, trendingPosts, communityPosts, widewaves });
    if (!delivered) {
      await User.updateOne({ _id: user._id, newsletterLastSentAt: now }, { $unset: { newsletterLastSentAt: 1 } });
      continue;
    }

    await User.updateOne({ _id: user._id, newsletterLastSentAt: now }, {
      $push: { newsletterSentPosts: { $each: selected.map((post) => post._id), $slice: -500 } }
    });
    sentCount += 1;
  }
  return { eligible: users.length, sent: sentCount, skippedNoPosts };
}

let newsletterTask = null;

let running = false;
let catchUpTimer = null;

async function newsletterTick() {
  if (running) return; // a slow previous tick is still sending
  running = true;
  try {
    const result = await sendWeeklyNewsletters();
    if (result.eligible) {
      logger.info(`Newsletter run: ${result.sent} sent, ${result.skippedNoPosts} skipped (nothing new to recommend), ${result.eligible} members were due.`);
    }
  } catch (error) {
    logger.error('Weekly newsletter delivery failed', error);
  } finally {
    running = false;
  }
}

function startNewsletterWorker() {
  if (newsletterTask) return newsletterTask;
  // The schedule itself is timezone-agnostic: each member's own clock is
  // checked inside sendWeeklyNewsletters.
  newsletterTask = cron.schedule(NEWSLETTER_CRON, newsletterTick, { timezone: 'UTC' });
  // Free hosts sleep: shortly after a (re)start, check whether a Sunday window is open and missed.
  catchUpTimer = setTimeout(newsletterTick, 60 * 1000);
  catchUpTimer.unref?.();
  logger.info(`Weekly newsletter worker started (Sunday ${Math.floor(NEWSLETTER_LOCAL_MINUTE / 60)}:${String(NEWSLETTER_LOCAL_MINUTE % 60).padStart(2, '0')} in each member's own time zone; default ${defaultTimezone()}).`);
  return newsletterTask;
}

function stopNewsletterWorker() {
  if (catchUpTimer) { clearTimeout(catchUpTimer); catchUpTimer = null; }
  if (!newsletterTask) return;
  newsletterTask.stop();
  newsletterTask = null;
}

module.exports = { localClock, NEWSLETTER_CRON, NEWSLETTER_LOCAL_MINUTE, NEWSLETTER_CATCH_UP_MINUTES, MIN_GAP_MS, isValidTimezone, isNewsletterWindow, mayBeSundayWindowSomewhere, buildNewsletterSelection, sendWeeklyNewsletters, startNewsletterWorker, stopNewsletterWorker };