// Early-life emails for new members:
//
//   * "Your post got its first reply" - the strongest hook there is, sent once,
//     the moment someone replies to a new member's post.
//   * A four-email welcome series across the first week, personalised to what
//     the member has (and has not) done yet, skipping anything already done.
//
// Both are optional ("Welcome emails and tips" in Settings), carry a one-click
// unsubscribe, and only go out during the member's local daytime (the series).
const cron = require('node-cron');
const User = require('../models/User');
const { weeklyDigest } = require('./widewaves');
const Post = require('../models/Post');
const Comment = require('../models/Comment');
const ReengagementLog = require('../models/ReengagementLog');
const { getInterestProfile } = require('./feedService');
const { getRecommendedCommunities } = require('./communityRecommendations');
const { sendLifecycleEmail } = require('./mailer');
const { isSendHour, dailyLimit, envEnabled } = require('./reengagement');
const { awardBadges, effectiveStreak, zoneOf } = require('./streaks');
const { getSiteConfig } = require('./siteConfig');
const { questionOfTheDay } = require('../utils/questions');
const { unsubscribeUrl } = require('../utils/unsubscribeToken');
const { preview } = require('../utils/textPreview');
const { badgeInfo } = require('../utils/badges');
const logger = require('./logger');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NEW_MEMBER_DAYS = 30;
const WELCOME_GAP_MS = 30 * HOUR_MS;
const WELCOME_CRON = '10,40 * * * *';
const PER_TICK_LIMIT = 40;

// Age windows (hours since sign-up). Non-overlapping, so a member sees at most
// one stage at a time and a missed window is simply skipped.
const WELCOME_STAGES = [
  { id: 'welcome-1', fromHours: 2, toHours: 36 },
  { id: 'welcome-2', fromHours: 36, toHours: 84 },
  { id: 'welcome-3', fromHours: 84, toHours: 132 },
  { id: 'welcome-4', fromHours: 132, toHours: 200 }
];

const appUrlOf = () => String(process.env.APP_URL || 'https://www.crowdwide.run.place').replace(/\/$/, '');
const firstNameOf = (user) => String(user.name || '').trim().split(/\s+/)[0] || '';
const plural = (count, one, many = `${one}s`) => `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;

// ------------------------------------------------------------------ first reply

// Call (fire and forget) after someone replies to / comments on a post.
async function handleReplyReceived({ postId, postAuthorId, replierId, replierName = '', replyText = '', now = new Date() }) {
  try {
    if (!postAuthorId || String(postAuthorId) === String(replierId)) return { sent: false, reason: 'self' };
    const author = await User.findById(postAuthorId).select('name email isVerified createdAt firstReplyAt firstReplyEmailSentAt notificationPreferences blockedUsers mutedUsers').lean();
    if (!author || author.firstReplyAt) return { sent: false, reason: 'not-first' };
    const claim = await User.updateOne({ _id: author._id, firstReplyAt: { $exists: false } }, { $set: { firstReplyAt: now } });
    if (!claim.modifiedCount) return { sent: false, reason: 'not-first' };
    await awardBadges(author._id, ['first-reply']);

    const isNew = author.createdAt && now.getTime() - new Date(author.createdAt).getTime() <= NEW_MEMBER_DAYS * DAY_MS;
    const hidden = [...(author.blockedUsers || []), ...(author.mutedUsers || [])].map(String).includes(String(replierId));
    if (!author.isVerified || !isNew || hidden || author.notificationPreferences?.emailWelcome === false || author.firstReplyEmailSentAt) return { sent: false, reason: 'not-eligible' };
    const emailClaim = await User.updateOne({ _id: author._id, firstReplyEmailSentAt: { $exists: false } }, { $set: { firstReplyEmailSentAt: now } });
    if (!emailClaim.modifiedCount) return { sent: false, reason: 'claimed' };

    const post = await Post.findById(postId).select('body type poll').lean();
    const postText = post ? preview(post.type === 'poll' && post.poll?.question ? post.poll.question : post.body, 120) : 'your post';
    const appUrl = appUrlOf();
    const replier = replierName || 'Someone';
    const delivered = await sendLifecycleEmail(author, {
      appUrl,
      label: 'First-reply email',
      subject: `${replier} replied to your post`,
      eyebrow: 'YOUR FIRST REPLY',
      heading: 'Someone replied to your post!',
      firstName: firstNameOf(author),
      message: `${replier} just replied to "${postText}". This is how conversations on Crowdwide begin.\n\nA quick reply back keeps it going - people who answer within a day tend to build a following fastest.`,
      preheader: `${replier}: ${preview(replyText, 80)}`,
      quote: replyText ? { author: replier, text: preview(replyText, 280) } : null,
      actionUrl: `${appUrl}/posts/${postId}`,
      actionLabel: 'See the reply',
      note: 'Tip: post or comment every day to build a streak and earn badges.',
      unsubscribeUrl: unsubscribeUrl(appUrl, 'welcome', author._id)
    });
    if (!delivered) {
      await User.updateOne({ _id: author._id, firstReplyEmailSentAt: now }, { $unset: { firstReplyEmailSentAt: 1 } });
      return { sent: false, reason: 'mail-failed' };
    }
    await ReengagementLog.create({ user: author._id, stage: 'first-reply', channels: ['email'], sentAt: now });
    return { sent: true };
  } catch (error) {
    logger.warn('First-reply email failed', error);
    return { sent: false, reason: 'error' };
  }
}

// ---------------------------------------------------------------- welcome series

function welcomeStageFor(ageMs, sent = []) {
  const hours = ageMs / HOUR_MS;
  return WELCOME_STAGES.find((stage) => hours >= stage.fromHours && hours < stage.toHours && !sent.includes(stage.id)) || null;
}

function dueWelcomeStage(user, now = new Date(), { ignoreHours = false } = {}) {
  if (!user.createdAt || !user.isVerified) return null;
  if (user.notificationPreferences?.emailWelcome === false) return null;
  if (user.suspendedUntil && new Date(user.suspendedUntil) > now) return null;
  const last = user.welcome?.lastSentAt ? new Date(user.welcome.lastSentAt).getTime() : 0;
  if (last && now.getTime() - last < WELCOME_GAP_MS) return null;
  const stage = welcomeStageFor(now.getTime() - new Date(user.createdAt).getTime(), user.welcome?.sent || []);
  if (!stage) return null;
  return ignoreHours || isSendHour(now, user.timezone) ? stage : null;
}

// facts: { posts, comments, joined, following, communities, likesReceived, streak, longest, badges }
// Returns { skip: true } when the member has already done what the email asks.
function buildWelcome(stageId, user, facts = {}, now = new Date()) {
  const appUrl = appUrlOf();
  const base = { appUrl, firstName: firstNameOf(user), unsubscribeUrl: unsubscribeUrl(appUrl, 'welcome', user._id), eyebrow: 'WELCOME TO CROWDWIDE', label: `Welcome email (${stageId})` };
  const qotd = questionOfTheDay(now);

  if (stageId === 'welcome-1') {
    const { posts = 0, joined = 0, following = 0 } = facts;
    const tick = (done, text) => (done ? `Done - ${text}` : text);
    return {
      ...base,
      subject: 'Welcome to Crowdwide - 3 quick steps to get started',
      heading: 'You are in. Here is how to make it yours.',
      message: 'Crowdwide works best when your feed knows what you like. Three small steps - each takes under a minute.',
      preheader: 'Join a community, follow a few people, say hello',
      steps: [
        tick(joined >= 2, `Join two or three communities that fit you${joined ? ` (you have joined ${joined})` : ''}`),
        tick(following >= 3, `Follow a few people whose posts you enjoy${following ? ` (you follow ${following})` : ''}`),
        tick(posts >= 1, `Share your first post - or answer today's question: "${qotd.text}"`)
      ],
      actionUrl: joined === 0 ? `${appUrl}/communities` : posts === 0 ? `${appUrl}/dashboard?ask=qotd` : `${appUrl}/dashboard`,
      actionLabel: joined === 0 ? 'Find communities' : posts === 0 ? "Answer today's question" : 'Open your feed',
      note: 'New voices get a fair chance here - your first post will be shown to people outside your network too.'
    };
  }

  if (stageId === 'welcome-2') {
    if ((facts.posts || 0) >= 1) return { skip: true };
    return {
      ...base,
      subject: 'Say hello in one line',
      heading: 'Your first post can be one sentence.',
      message: `Most people never post because they wait for a perfect idea. Skip that: answer today's question in a line or two.\n\n"${qotd.text}"`,
      preheader: qotd.text,
      steps: ['Tap the button below - the question is already in the box', 'Write a sentence or two', 'Post it. Someone will usually reply within a day'],
      actionUrl: `${appUrl}/dashboard?ask=qotd`,
      actionLabel: 'Answer in one tap',
      note: 'Posting or commenting every day builds a streak and earns badges.'
    };
  }

  if (stageId === 'welcome-3') {
    const communities = facts.communities || [];
    if ((facts.joined || 0) >= 3 || !communities.length) return { skip: true };
    return {
      ...base,
      subject: 'Communities picked for you',
      heading: 'A few communities that match your interests',
      message: 'Communities are where Crowdwide gets personal - smaller rooms, real conversations. These match what you told us you like.',
      preheader: communities.map((community) => community.name).join(' · '),
      items: communities.slice(0, 3).map((community) => ({
        title: community.name,
        text: `${preview(community.description || 'A friendly community.', 140)} · ${plural(community.membersCount || 0, 'member')}`,
        url: `${appUrl}/communities/${community.slug}`,
        linkLabel: 'Take a look'
      })),
      actionUrl: `${appUrl}/communities`,
      actionLabel: 'Browse all communities'
    };
  }

  // welcome-4
  const stats = [];
  stats.push({ label: 'Posts', value: String(facts.posts || 0) });
  stats.push({ label: 'Comments', value: String(facts.comments || 0) });
  stats.push({ label: 'Likes received', value: String(facts.likesReceived || 0) });
  stats.push({ label: 'Best streak', value: `${plural(facts.longest || 0, 'day')}` });
  const badgeNames = (facts.badges || []).map((key) => badgeInfo(key)?.name).filter(Boolean);
  return {
    ...base,
    subject: 'Your first week on Crowdwide',
    eyebrow: 'YOUR FIRST WEEK',
    heading: 'One week in - here is how it went',
    message: `${badgeNames.length ? `You have earned ${plural(badgeNames.length, 'badge')}: ${badgeNames.join(', ')}.\n\n` : ''}${(facts.posts || 0) + (facts.comments || 0) === 0 ? 'You have not posted yet - and that is fine. One comment is enough to start a streak.' : 'Nice start. Keep a streak going - post or comment a little each day.'}\n\nKnow someone who would enjoy it? This week's best posts are public, so you can share them: ${appUrl}/top`,
    preheader: 'Your numbers, your badges, and what to do next',
    details: stats,
    actionUrl: `${appUrl}/dashboard`,
    actionLabel: 'Keep it going'
  };
}

async function loadFacts(stageId, user) {
  if (stageId === 'welcome-1') {
    return { posts: await Post.countDocuments({ author: user._id, status: 'published' }), joined: (user.joinedCommunities || []).length, following: (user.following || []).length };
  }
  if (stageId === 'welcome-2') return { posts: await Post.countDocuments({ author: user._id, status: 'published' }) };
  if (stageId === 'welcome-3') {
    const joined = (user.joinedCommunities || []).length;
    if (joined >= 3) return { joined, communities: [] };
    return { joined, communities: await getRecommendedCommunities(user, { limit: 3, getInterestProfile }) };
  }
  const [posts, comments, likes] = await Promise.all([
    Post.countDocuments({ author: user._id, status: 'published' }),
    Comment.countDocuments({ author: user._id }),
    Post.aggregate([{ $match: { author: user._id, status: 'published' } }, { $group: { _id: null, total: { $sum: { $size: { $ifNull: ['$likes', []] } } } } }])
  ]);
  const streak = effectiveStreak(user.streak, new Date(), zoneOf(user));
  return { posts, comments, likesReceived: likes[0]?.total || 0, longest: Math.max(user.streak?.longest || 0, streak.current), badges: (user.badges || []).map((badge) => badge.key) };
}

async function sendWelcomeEmails({ now = new Date(), limit = PER_TICK_LIMIT, dryRun = false, ignoreHours = false } = {}) {
  const result = { candidates: 0, due: 0, sent: 0, skipped: 0, disabled: false };
  if (!envEnabled()) { result.disabled = true; return result; }
  const settings = await getSiteConfig();
  if (settings.welcomeEmailsEnabled === false) { result.disabled = true; return result; }

  const sentToday = await ReengagementLog.countDocuments({ sentAt: { $gte: new Date(now.getTime() - DAY_MS) } });
  const budget = Math.min(limit, Math.max(0, dailyLimit() - sentToday));
  if (!budget && !dryRun) return result;

  const gapCutoff = new Date(now.getTime() - WELCOME_GAP_MS);
  const candidates = await User.find({
    isVerified: true,
    'notificationPreferences.emailWelcome': { $ne: false },
    createdAt: { $gte: new Date(now.getTime() - WELCOME_STAGES[3].toHours * HOUR_MS), $lte: new Date(now.getTime() - WELCOME_STAGES[0].fromHours * HOUR_MS) },
    $and: [
      { $or: [{ suspendedUntil: null }, { suspendedUntil: { $lte: now } }] },
      { $or: [{ 'welcome.lastSentAt': null }, { 'welcome.lastSentAt': { $lte: gapCutoff } }] }
    ]
  }).select('_id name email isVerified createdAt timezone welcome suspendedUntil notificationPreferences hashtags following joinedCommunities bookmarks searchHistory recentViews streak badges')
    .sort({ createdAt: 1 }).limit(300).lean();
  result.candidates = candidates.length;
  const due = candidates.map((user) => ({ user, stage: dueWelcomeStage(user, now, { ignoreHours }) })).filter((entry) => entry.stage);
  result.due = due.length;
  if (!due.length || dryRun) return result;

  let sent = 0;
  for (const { user, stage } of due) {
    if (sent >= budget) break;
    try {
      const content = buildWelcome(stage.id, user, await loadFacts(stage.id, user), now);
      if (content.skip) {
        // Already done what this email asks: mark it handled so it is not re-checked every tick.
        await User.updateOne({ _id: user._id }, { $addToSet: { 'welcome.sent': stage.id } });
        result.skipped += 1;
        continue;
      }
      const previous = user.welcome || {};
      const claim = await User.updateOne({
        _id: user._id,
        'welcome.sent': { $ne: stage.id },
        $or: [{ 'welcome.lastSentAt': null }, { 'welcome.lastSentAt': { $lte: gapCutoff } }]
      }, { $addToSet: { 'welcome.sent': stage.id }, $set: { 'welcome.lastSentAt': now } });
      if (!claim.modifiedCount) continue;
      content.widewaves = content.widewaves || await weeklyDigest({ limit: 2 });
      const delivered = await sendLifecycleEmail(user, content);
      if (!delivered) {
        await User.updateOne({ _id: user._id, 'welcome.lastSentAt': now }, {
          $pull: { 'welcome.sent': stage.id },
          ...(previous.lastSentAt ? { $set: { 'welcome.lastSentAt': previous.lastSentAt } } : { $unset: { 'welcome.lastSentAt': 1 } })
        });
        continue;
      }
      await ReengagementLog.create({ user: user._id, stage: stage.id, channels: ['email'], sentAt: now });
      sent += 1;
      result.sent += 1;
    } catch (error) {
      logger.error('Welcome email failed for one member', error);
    }
  }
  return result;
}

// ---------------------------------------------------------------------- worker

let task = null;
let running = false;
let startupTimer = null;

async function tick() {
  if (running) return;
  running = true;
  try {
    const welcome = await sendWelcomeEmails();
    if (welcome.sent || welcome.due) logger.info(`Welcome series: ${welcome.sent} sent, ${welcome.skipped} skipped, ${welcome.due} due.`);
    const { sendStreakSavers } = require('./streaks');
    const savers = await sendStreakSavers();
    if (savers.sent) logger.info(`Streak savers: ${savers.sent} push reminders sent.`);
  } catch (error) {
    logger.error('Lifecycle run failed', error);
  } finally {
    running = false;
  }
}

function startLifecycleWorker() {
  if (task) return task;
  task = cron.schedule(WELCOME_CRON, tick, { timezone: 'UTC' });
  startupTimer = setTimeout(tick, 3 * 60 * 1000);
  startupTimer.unref?.();
  logger.info('Welcome series and streak-saver worker started (every 30 minutes, local daytime only).');
  return task;
}

function stopLifecycleWorker() {
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  if (!task) return;
  task.stop();
  task = null;
}

module.exports = {
  WELCOME_STAGES, WELCOME_GAP_MS, NEW_MEMBER_DAYS,
  handleReplyReceived, welcomeStageFor, dueWelcomeStage, buildWelcome, sendWelcomeEmails,
  startLifecycleWorker, stopLifecycleWorker
};
