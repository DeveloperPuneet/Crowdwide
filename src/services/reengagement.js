// Come-back reminders. A member who goes quiet gets, at most, three gentle
// nudges - each different, each with something worth coming back for - and
// then nothing more until they have visited again:
//
//   after 24 hours  -> "question": a community question they can answer
//                      (falls back to today's Question of the Day)
//   after  3 days   -> "discussion": a genuinely active discussion + what is new
//   after  7 days   -> "winback": what they missed (replies, followers) + top posts
//
// Channels: email, plus web push when the member opted into push, plus a
// notification waiting for them in the app. Everything respects the member's
// "Come-back reminders" setting, a one-click unsubscribe link, an admin master
// switch, the member's local daytime hours, and a daily send cap.
const cron = require('node-cron');
const User = require('../models/User');
const Post = require('../models/Post');
const Notification = require('../models/Notification');
const LoginSession = require('../models/LoginSession');
const ReengagementLog = require('../models/ReengagementLog');
const Community = require('../models/Community');
const { getInterestProfile } = require('./feedService');
const { buildNewsletterSelection, localClock, isValidTimezone } = require('./newsletterWorker');
const { interestScore, ageHours, hotValue } = require('../utils/feedRanker');
const { questionOfTheDay } = require('../utils/questions');
const { reminderUnsubscribeUrl } = require('../utils/unsubscribeToken');
const { preview } = require('../utils/textPreview');
const { sendReengagementEmail } = require('./mailer');
const { sendPushToUser } = require('./push');
const { getSiteConfig } = require('./siteConfig');
const logger = require('./logger');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const STAGES = [
  { id: 'question', fromHours: 24, toHours: 72 },
  { id: 'discussion', fromHours: 72, toHours: 168 },
  { id: 'winback', fromHours: 168, toHours: 45 * 24 }
];
// Even if a stage window were missed, never send two reminders closer than this.
const MIN_GAP_MS = 40 * HOUR_MS;
// Reminders only go out during the member's local daytime.
const SEND_FROM_MINUTE = 10 * 60;
const SEND_UNTIL_MINUTE = 21 * 60;
const REENGAGEMENT_CRON = '*/30 * * * *';
const PER_TICK_LIMIT = 40;
const NEW_MEMBER_GRACE_MS = 7 * DAY_MS;
const AWAY_MS = DAY_MS; // a gap this long shows the "welcome back" summary

const dailyLimit = () => {
  const value = Number(process.env.REENGAGEMENT_DAILY_LIMIT);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 150;
};
const envEnabled = () => String(process.env.REENGAGEMENT_ENABLED || 'on').trim().toLowerCase() !== 'off';
const defaultZone = () => (isValidTimezone(process.env.NEWSLETTER_TIMEZONE) ? process.env.NEWSLETTER_TIMEZONE : 'Asia/Kolkata');
const appUrlOf = () => String(process.env.APP_URL || 'https://www.crowdwide.run.place').replace(/\/$/, '');

// ---------------------------------------------------------------- pure rules

// Which stage (if any) is due for someone who has been away `inactiveMs`.
function stageFor(inactiveMs, sent = []) {
  const hours = inactiveMs / HOUR_MS;
  return STAGES.find((stage) => hours >= stage.fromHours && hours < stage.toHours && !sent.includes(stage.id)) || null;
}

// Stages already sent in the member's CURRENT away-spell. Coming back after the
// last reminder starts a fresh spell, so a later absence is nudged again.
function currentSpellSent(user) {
  const info = user.reengagement || {};
  if (!info.lastSentAt) return [];
  if (user.lastActiveAt && new Date(user.lastActiveAt) > new Date(info.lastSentAt)) return [];
  return Array.isArray(info.sent) ? info.sent : [];
}

function isSendHour(now, zone) {
  const { minutes } = localClock(now, isValidTimezone(zone) ? zone : defaultZone());
  return minutes >= SEND_FROM_MINUTE && minutes < SEND_UNTIL_MINUTE;
}

function dueStage(user, now = new Date()) {
  if (!user.lastActiveAt) return null;
  // Members in their first week are looked after by the welcome series instead.
  if (user.createdAt && now.getTime() - new Date(user.createdAt).getTime() < NEW_MEMBER_GRACE_MS) return null;
  const lastSentAt = user.reengagement?.lastSentAt ? new Date(user.reengagement.lastSentAt).getTime() : 0;
  if (lastSentAt && now.getTime() - lastSentAt < MIN_GAP_MS) return null;
  if (user.suspendedUntil && new Date(user.suspendedUntil) > now) return null;
  if (user.notificationPreferences?.emailReminders === false) return null;
  const stage = stageFor(now.getTime() - new Date(user.lastActiveAt).getTime(), currentSpellSent(user));
  if (!stage) return null;
  return isSendHour(now, user.timezone) ? stage : null;
}

const idOf = (value) => String(value?._id || value || '');

function canSee(post, joined) {
  return !post.community || !post.community.isPrivate || joined.has(idOf(post.community));
}

function isQuestionPost(post) {
  return post.type === 'poll' || /\?/.test(String(post.body || ''));
}

function usablePosts(posts, user, sentSet) {
  const joined = new Set((user.joinedCommunities || []).map(String));
  return posts.filter((post) => !sentSet.has(idOf(post))
    && idOf(post.author) !== idOf(user)
    && canSee(post, joined));
}

// Open questions that still want answers: matching interests/communities,
// recent, and with few replies so an answer actually matters.
function pickQuestions(posts, user, interests, now = Date.now(), limit = 3) {
  const sent = new Set((user.reengagement?.sentPosts || []).map(String));
  const joined = new Set((user.joinedCommunities || []).map(String));
  const following = new Set((user.following || []).map(String));
  return usablePosts(posts, user, sent)
    .filter(isQuestionPost)
    .filter((post) => ageHours(post.createdAt, now) <= 7 * 24)
    .map((post) => {
      const comments = post.commentsCount || 0;
      const score = interestScore(post.hashtags || [], interests)
        + (post.community && joined.has(idOf(post.community)) ? 0.5 : 0)
        + (following.has(idOf(post.author)) ? 0.3 : 0)
        + (comments <= 2 ? 0.4 : comments <= 5 ? 0.15 : 0)
        + (ageHours(post.createdAt, now) <= 48 ? 0.3 : 0.1);
      return { post, score };
    })
    .sort((a, b) => b.score - a.score || new Date(b.post.createdAt) - new Date(a.post.createdAt))
    .slice(0, limit)
    .map(({ post }) => post);
}

// Discussions that are actually going somewhere: several replies, recent.
function pickDiscussions(posts, user, interests, now = Date.now(), limit = 3) {
  const sent = new Set((user.reengagement?.sentPosts || []).map(String));
  const joined = new Set((user.joinedCommunities || []).map(String));
  return usablePosts(posts, user, sent)
    .filter((post) => (post.commentsCount || 0) >= 2 || (post.likes?.length || 0) >= 4)
    .filter((post) => ageHours(post.createdAt, now) <= 7 * 24)
    .map((post) => {
      const points = (post.likes?.length || 0) + (post.commentsCount || 0) * 3 + (post.sharesCount || 0) * 4;
      const score = hotValue(points, ageHours(post.createdAt, now))
        + interestScore(post.hashtags || [], interests) * 2
        + (post.community && joined.has(idOf(post.community)) ? 1 : 0);
      return { post, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ post }) => post);
}

function plural(count, one, many = `${one}s`) {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
}

// Builds what to say. Returns null when there is nothing worth interrupting
// someone for (we would rather send nothing than send filler).
function buildReminder(stage, user, ctx) {
  const { posts = [], interests = new Map(), authorAffinity = new Map(), now = Date.now(), pulse = null, missed = null, appUrl = appUrlOf() } = ctx;
  const first = String(user.name || '').trim().split(/\s+/)[0] || '';
  const unsubscribeUrl = reminderUnsubscribeUrl(appUrl, user._id);
  const base = { stage, firstName: first, unsubscribeUrl, appUrl, posts: [], question: null, stats: [] };

  if (stage === 'question') {
    const [lead] = pickQuestions(posts, user, interests, now, 3);
    if (lead) {
      const rest = pickQuestions(posts, user, interests, now, 3).slice(1);
      const asker = lead.author?.name || 'A member';
      const snippet = lead.type === 'poll' && lead.poll?.question ? lead.poll.question : preview(lead.body, 140);
      return {
        ...base,
        subject: `${asker} asked: ${preview(snippet, 60)}`,
        eyebrow: 'A QUESTION FOR YOU',
        heading: 'Someone would love your take',
        message: `${asker}${lead.community?.name ? ` in ${lead.community.name}` : ''} asked a question and it is still waiting for answers.\n\nA sentence or two is plenty - it takes less than a minute.`,
        preheader: preview(snippet, 90),
        posts: [lead, ...rest],
        actionUrl: `${appUrl}/posts/${lead._id}`,
        actionLabel: 'Share your answer',
        pushBody: `${asker} asked: ${preview(snippet, 90)}`,
        pushUrl: `/posts/${lead._id}`,
        sentPostIds: [lead, ...rest].map((post) => post._id)
      };
    }
    const qotd = questionOfTheDay(new Date(now));
    return {
      ...base,
      subject: `Today's question: ${preview(qotd.text, 70)}`,
      eyebrow: 'QUESTION OF THE DAY',
      heading: first ? `${first}, what is your answer?` : 'What is your answer?',
      message: 'Every day Crowdwide asks one open question anyone can answer. No right answers - just yours.',
      preheader: qotd.text,
      question: { text: qotd.text },
      actionUrl: `${appUrl}/dashboard?ask=qotd`,
      actionLabel: 'Answer in one tap',
      pushBody: qotd.text,
      pushUrl: '/dashboard?ask=qotd',
      sentPostIds: []
    };
  }

  if (stage === 'discussion') {
    const picks = pickDiscussions(posts, user, interests, now, 3);
    if (!picks.length) return null;
    const stats = [];
    if (pulse?.posts) stats.push({ label: 'New this week', value: `${plural(pulse.posts, 'post')} · ${plural(pulse.members || 0, 'new member')}` });
    if (pulse?.communities) stats.push({ label: 'Communities', value: `${plural(pulse.communities, 'new community', 'new communities')} opened` });
    const lead = picks[0];
    return {
      ...base,
      subject: `Worth reading: ${preview(lead.body || lead.poll?.question || 'a lively discussion', 60)}`,
      eyebrow: 'WORTH YOUR TIME',
      heading: 'The conversation moved on - catch up',
      message: `${plural(lead.commentsCount || 0, 'person', 'people')} ${(lead.commentsCount || 0) === 1 ? 'has' : 'have'} weighed in on the discussion below, and a few more are worth a look.`,
      preheader: 'A discussion that is picking up, chosen for your interests',
      posts: picks,
      stats,
      actionUrl: `${appUrl}/posts/${lead._id}`,
      actionLabel: 'Read the discussion',
      pushBody: `Worth reading: ${preview(lead.body || lead.poll?.question || '', 90)}`,
      pushUrl: `/posts/${lead._id}`,
      sentPostIds: picks.map((post) => post._id)
    };
  }

  // winback
  const selection = buildNewsletterSelection(posts, user, interests, now, authorAffinity);
  const picked = [];
  for (const post of [...selection.personalizedPosts.slice(0, 2), ...selection.trendingPosts.slice(0, 2), ...selection.communityPosts.slice(0, 1)]) {
    if (!picked.some((existing) => idOf(existing) === idOf(post))) picked.push(post);
    if (picked.length === 3) break;
  }
  const stats = [];
  const missedTotal = (missed?.likes || 0) + (missed?.comments || 0) + (missed?.follows || 0) + (missed?.mentions || 0);
  if (missed?.comments) stats.push({ label: 'Replies', value: plural(missed.comments, 'new reply', 'new replies') });
  if (missed?.likes) stats.push({ label: 'Likes', value: plural(missed.likes, 'like') });
  if (missed?.follows) stats.push({ label: 'Followers', value: plural(missed.follows, 'new follower') });
  if (missed?.mentions) stats.push({ label: 'Mentions', value: plural(missed.mentions, 'mention') });
  if (!picked.length && !missedTotal) return null;
  return {
    ...base,
    subject: missedTotal ? `${plural(missedTotal, 'thing')} happened on Crowdwide while you were away` : 'We saved you a seat on Crowdwide',
    eyebrow: 'WE MISS YOU',
    heading: missedTotal ? 'Your people are still here' : 'A few things you might have missed',
    message: missedTotal
      ? 'Here is what happened around your posts while you were away. Nothing is lost - it is all waiting for you.'
      : 'Crowdwide kept moving. Here are a few conversations that matched your interests.',
    preheader: missedTotal ? 'People reacted to your posts while you were away' : 'Conversations chosen for your interests',
    posts: picked,
    stats,
    actionUrl: `${appUrl}/dashboard`,
    actionLabel: 'Pick up where you left off',
    note: 'This is the last reminder for now. We will not email you again about this unless you come back and drift away again. You can also turn these off in Settings.',
    pushBody: missedTotal ? `${plural(missedTotal, 'new reaction')} on your posts while you were away` : 'A few conversations you might have missed',
    pushUrl: '/dashboard',
    sentPostIds: picked.map((post) => post._id)
  };
}

// ----------------------------------------------------------- activity tracking

// Called when a member uses the site (throttled by the caller). Remembers when
// they were last here, notes a long absence in the session so the dashboard can
// greet them with a "while you were away" summary, and credits a reminder if it
// brought them back.
async function recordActivity(userId, session, now = new Date()) {
  const before = await User.findOneAndUpdate(
    { _id: userId },
    { $set: { lastActiveAt: now } },
    { projection: { lastActiveAt: 1, 'reengagement.lastSentAt': 1 }, returnDocument: 'before' }
  ).lean();
  if (!before) return null;
  const previous = before.lastActiveAt ? new Date(before.lastActiveAt) : null;
  if (previous && now - previous >= AWAY_MS && session) session.awayFrom = previous.toISOString();
  const lastSent = before.reengagement?.lastSentAt ? new Date(before.reengagement.lastSentAt) : null;
  if (lastSent && (!previous || previous < lastSent) && now - lastSent <= 7 * DAY_MS) {
    await ReengagementLog.findOneAndUpdate({ user: userId, returnedAt: null }, { $set: { returnedAt: now } }, { sort: { sentAt: -1 } });
  }
  return previous;
}

// One-off for accounts that existed before activity was tracked: use the newest
// sign-in session we have, otherwise treat them as active right now (so nobody
// is hit by a surprise burst of reminders the day this ships).
async function backfillLastActive(now = new Date()) {
  const missing = await User.countDocuments({ lastActiveAt: { $exists: false } });
  if (!missing) return 0;
  const latest = await LoginSession.aggregate([{ $group: { _id: '$user', lastSeenAt: { $max: '$lastSeenAt' } } }]);
  if (latest.length) {
    await User.bulkWrite(latest.map((row) => ({
      updateOne: { filter: { _id: row._id, lastActiveAt: { $exists: false } }, update: { $set: { lastActiveAt: row.lastSeenAt } } }
    })), { ordered: false });
  }
  await User.updateMany({ lastActiveAt: { $exists: false } }, { $set: { lastActiveAt: now } });
  return missing;
}

// What happened while the member was away (for the dashboard welcome-back card).
async function awaySummary(user, since, now = new Date()) {
  const sinceDate = new Date(since);
  if (Number.isNaN(sinceDate.getTime())) return null;
  const joined = (user.joinedCommunities || []);
  const [notifications, communityPosts, topPost] = await Promise.all([
    Notification.find({ recipient: user._id, createdAt: { $gte: sinceDate } }).select('type').limit(500).lean(),
    joined.length ? Post.countDocuments({ community: { $in: joined }, status: 'published', createdAt: { $gte: sinceDate }, author: { $ne: user._id } }) : 0,
    joined.length ? Post.findOne({ community: { $in: joined }, status: 'published', createdAt: { $gte: sinceDate }, author: { $ne: user._id } }).sort({ commentsCount: -1, createdAt: -1 }).select('body type poll community').populate('community', 'name').lean() : null
  ]);
  const count = (...types) => notifications.filter((item) => types.includes(item.type)).length;
  const summary = {
    days: Math.max(1, Math.round((now - sinceDate) / DAY_MS)),
    likes: count('like'),
    comments: count('comment', 'reply'),
    follows: count('follow'),
    mentions: count('mention'),
    communityPosts,
    topPost: topPost ? { _id: topPost._id, text: preview(topPost.type === 'poll' && topPost.poll?.question ? topPost.poll.question : topPost.body, 110), community: topPost.community?.name || '' } : null
  };
  summary.total = summary.likes + summary.comments + summary.follows + summary.mentions + summary.communityPosts;
  return summary.total ? summary : null;
}

// ------------------------------------------------------------------ the sender

async function loadContext(now) {
  const since = new Date(now.getTime() - 14 * DAY_MS);
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
  const [posts, newPosts, newMembers, newCommunities] = await Promise.all([
    Post.find({ status: 'published', replyTo: null, moderationStatus: { $ne: 'reported' }, createdAt: { $gte: since } })
      .sort({ createdAt: -1 }).limit(400)
      .populate('author', 'name')
      .populate('community', 'name slug isPrivate')
      .lean(),
    Post.countDocuments({ status: 'published', createdAt: { $gte: weekAgo } }),
    User.countDocuments({ isVerified: true, createdAt: { $gte: weekAgo } }),
    Community.countDocuments({ createdAt: { $gte: weekAgo }, isPrivate: { $ne: true } })
  ]);
  return { posts, pulse: { posts: newPosts, members: newMembers, communities: newCommunities } };
}

async function missedFor(user) {
  const rows = await Notification.find({ recipient: user._id, createdAt: { $gte: user.lastActiveAt } }).select('type').limit(500).lean();
  const count = (...types) => rows.filter((row) => types.includes(row.type)).length;
  return { likes: count('like'), comments: count('comment', 'reply'), follows: count('follow'), mentions: count('mention') };
}

async function sendReengagementReminders({ now = new Date(), limit = PER_TICK_LIMIT, dryRun = false, ignoreHours = false } = {}) {
  const result = { candidates: 0, due: 0, sent: 0, skippedNothingToSay: 0, byStage: { question: 0, discussion: 0, winback: 0 }, disabled: false };
  if (!envEnabled()) { result.disabled = true; return result; }
  const settings = await getSiteConfig();
  if (settings.reengagementEnabled === false) { result.disabled = true; return result; }

  const sentToday = await ReengagementLog.countDocuments({ sentAt: { $gte: new Date(now.getTime() - DAY_MS) } });
  const budget = Math.min(limit, Math.max(0, dailyLimit() - sentToday));
  if (!budget && !dryRun) return result;

  const gapCutoff = new Date(now.getTime() - MIN_GAP_MS);
  const candidates = await User.find({
    isVerified: true,
    'notificationPreferences.emailReminders': { $ne: false },
    lastActiveAt: { $lte: new Date(now.getTime() - STAGES[0].fromHours * HOUR_MS), $gte: new Date(now.getTime() - STAGES[2].toHours * HOUR_MS) },
    $and: [
      { $or: [{ suspendedUntil: null }, { suspendedUntil: { $lte: now } }] },
      { $or: [{ 'reengagement.lastSentAt': null }, { 'reengagement.lastSentAt': { $lte: gapCutoff } }] }
    ]
  }).select('_id name email timezone createdAt pushNotificationsEnabled lastActiveAt reengagement suspendedUntil notificationPreferences hashtags following joinedCommunities bookmarks searchHistory recentViews newsletterSentPosts')
    .sort({ lastActiveAt: -1 }).limit(400).lean();
  result.candidates = candidates.length;

  const due = candidates
    .map((user) => ({ user, stage: ignoreHours ? stageDisregardingHours(user, now) : dueStage(user, now) }))
    .filter((entry) => entry.stage);
  result.due = due.length;
  if (!due.length || dryRun) return result;

  const ctx = await loadContext(now);
  for (const { user, stage } of due.slice(0, budget)) {
    try {
      const profile = await getInterestProfile(user);
      const missed = stage.id === 'winback' ? await missedFor(user) : null;
      const reminder = buildReminder(stage.id, user, { ...ctx, interests: profile.interests, authorAffinity: profile.authorAffinity, missed, now: now.getTime() });
      if (!reminder) { result.skippedNothingToSay += 1; continue; }

      // Claim before sending so two overlapping ticks (or two instances) can never double-send.
      const previous = user.reengagement || {};
      const spellSent = currentSpellSent(user);
      const claim = await User.updateOne({
        _id: user._id,
        lastActiveAt: user.lastActiveAt,
        $or: [{ 'reengagement.lastSentAt': null }, { 'reengagement.lastSentAt': { $lte: gapCutoff } }]
      }, { $set: { 'reengagement.sent': [...spellSent, stage.id], 'reengagement.lastSentAt': now } });
      if (!claim.modifiedCount) continue;

      const emailed = await sendReengagementEmail(user, reminder);
      if (!emailed) {
        await User.updateOne({ _id: user._id, 'reengagement.lastSentAt': now }, previous.lastSentAt
          ? { $set: { 'reengagement.sent': previous.sent || [], 'reengagement.lastSentAt': previous.lastSentAt } }
          : { $unset: { 'reengagement.lastSentAt': 1 }, $set: { 'reengagement.sent': previous.sent || [] } });
        continue;
      }
      const channels = ['email'];
      if (reminder.sentPostIds?.length) {
        await User.updateOne({ _id: user._id }, { $push: { 'reengagement.sentPosts': { $each: reminder.sentPostIds, $slice: -60 } } });
      }
      try {
        await Notification.create({ recipient: user._id, type: 'reminder', message: reminder.pushBody, url: reminder.pushUrl, ...(reminder.sentPostIds?.[0] && stage.id !== 'winback' ? { post: reminder.sentPostIds[0] } : {}) });
        channels.push('in-app');
        if (user.pushNotificationsEnabled === true) {
          await sendPushToUser(user._id, { title: 'Crowdwide', body: reminder.pushBody, url: reminder.pushUrl });
          channels.push('push');
        }
      } catch (error) {
        logger.warn('Reminder side channels failed (email was sent)', error);
      }
      await ReengagementLog.create({ user: user._id, stage: stage.id, channels, sentAt: now });
      result.sent += 1;
      result.byStage[stage.id] += 1;
    } catch (error) {
      logger.error('Re-engagement reminder failed for one member', error);
    }
  }
  return result;
}

// Used by the manual script: ignores the "local daytime" rule.
function stageDisregardingHours(user, now) {
  if (!user.lastActiveAt) return null;
  if (user.createdAt && now.getTime() - new Date(user.createdAt).getTime() < NEW_MEMBER_GRACE_MS) return null;
  const lastSentAt = user.reengagement?.lastSentAt ? new Date(user.reengagement.lastSentAt).getTime() : 0;
  if (lastSentAt && now.getTime() - lastSentAt < MIN_GAP_MS) return null;
  if (user.suspendedUntil && new Date(user.suspendedUntil) > now) return null;
  return stageFor(now.getTime() - new Date(user.lastActiveAt).getTime(), currentSpellSent(user));
}

async function reengagementReport(now = new Date(), days = 14) {
  const since = new Date(now.getTime() - days * DAY_MS);
  const rows = await ReengagementLog.aggregate([
    { $match: { sentAt: { $gte: since } } },
    { $group: { _id: '$stage', sent: { $sum: 1 }, returned: { $sum: { $cond: [{ $ifNull: ['$returnedAt', false] }, 1, 0] } } } }
  ]);
  const byStage = Object.fromEntries(STAGES.map((stage) => [stage.id, { sent: 0, returned: 0 }]));
  rows.forEach((row) => { if (byStage[row._id]) byStage[row._id] = { sent: row.sent, returned: row.returned }; });
  const sent = Object.values(byStage).reduce((total, row) => total + row.sent, 0);
  const returned = Object.values(byStage).reduce((total, row) => total + row.returned, 0);
  return { days, sent, returned, rate: sent ? Math.round((returned / sent) * 100) : 0, byStage };
}

// ---------------------------------------------------------------- the worker

let task = null;
let running = false;
let startupTimer = null;

async function tick() {
  if (running) return;
  running = true;
  try {
    const result = await sendReengagementReminders();
    if (result.sent || result.due) logger.info(`Re-engagement run: ${result.sent} sent (${result.byStage.question} question, ${result.byStage.discussion} discussion, ${result.byStage.winback} win-back), ${result.due} due.`);
  } catch (error) {
    logger.error('Re-engagement run failed', error);
  } finally {
    running = false;
  }
}

function startReengagementWorker() {
  if (task) return task;
  backfillLastActive().then((count) => { if (count) logger.info(`Re-engagement: recorded a starting activity time for ${count} existing members.`); })
    .catch((error) => logger.error('Re-engagement backfill failed', error));
  task = cron.schedule(REENGAGEMENT_CRON, tick, { timezone: 'UTC' });
  startupTimer = setTimeout(tick, 2 * 60 * 1000);
  startupTimer.unref?.();
  logger.info(`Come-back reminders ${envEnabled() ? 'started' : 'are OFF (REENGAGEMENT_ENABLED=off)'} (24h question, 3-day discussion, 7-day win-back; up to ${dailyLimit()}/day, local daytime only).`);
  return task;
}

function stopReengagementWorker() {
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  if (!task) return;
  task.stop();
  task = null;
}

module.exports = {
  STAGES, MIN_GAP_MS, AWAY_MS, REENGAGEMENT_CRON, dailyLimit, envEnabled,
  stageFor, currentSpellSent, isSendHour, dueStage, pickQuestions, pickDiscussions, buildReminder,
  recordActivity, backfillLastActive, awaySummary, sendReengagementReminders, reengagementReport,
  startReengagementWorker, stopReengagementWorker
};
