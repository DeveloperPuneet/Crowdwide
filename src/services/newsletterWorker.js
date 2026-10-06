const cron = require('node-cron');
const User = require('../models/User');
const Post = require('../models/Post');
const { getInterestProfile } = require('./feedService');
const { interestScore, ageHours, hotValue } = require('../utils/feedRanker');
const { sendWeeklyNewsletter } = require('./mailer');
const logger = require('./logger');

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const NEWSLETTER_CRON = '30 10 * * 0';

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

async function sendWeeklyNewsletters({ now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - WEEK_MS);
  const users = await User.find({
    isVerified: true,
    'notificationPreferences.emailNewsletter': { $ne: false },
    $or: [{ newsletterLastSentAt: { $lte: cutoff } }, { newsletterLastSentAt: { $exists: false } }]
  }).select('_id name email hashtags following joinedCommunities bookmarks searchHistory recentViews newsletterSentPosts newsletterLastSentAt').lean();
  let sentCount = 0;
  const posts = await Post.find({
    status: 'published',
    createdAt: { $gte: new Date(now.getTime() - 30 * DAY_MS) },
    moderationStatus: { $ne: 'reported' }
  }).sort({ createdAt: -1 }).limit(500)
    .populate('author', 'name')
    .populate('community', 'name slug isPrivate hashtags')
    .lean();

  for (const user of users) {
    if (!posts.length) continue;

    const interestProfile = await getInterestProfile(user);
    const { personalizedPosts, trendingPosts, communityPosts } = buildNewsletterSelection(
      posts, user, interestProfile.interests, now.getTime(), interestProfile.authorAffinity
    );
    const selected = [...personalizedPosts, ...trendingPosts, ...communityPosts];
    if (!selected.length) continue;
    const claim = await User.updateOne({
      _id: user._id,
      isVerified: true,
      'notificationPreferences.emailNewsletter': { $ne: false },
      $or: [{ newsletterLastSentAt: { $lte: cutoff } }, { newsletterLastSentAt: { $exists: false } }]
    }, { $set: { newsletterLastSentAt: now } });
    if (!claim.modifiedCount) continue;
    const delivered = await sendWeeklyNewsletter(user, { personalizedPosts, trendingPosts, communityPosts });
    if (!delivered) {
      await User.updateOne({ _id: user._id, newsletterLastSentAt: now }, { $unset: { newsletterLastSentAt: 1 } });
      continue;
    }

    await User.updateOne({ _id: user._id, newsletterLastSentAt: now }, {
      $push: { newsletterSentPosts: { $each: selected.map((post) => post._id), $slice: -500 } }
    });
    sentCount += 1;
  }
  return { eligible: users.length, sent: sentCount };
}

let newsletterTask = null;

function startNewsletterWorker() {
  if (newsletterTask) return newsletterTask;
  const timezone = process.env.TZ || 'UTC';
  newsletterTask = cron.schedule(NEWSLETTER_CRON, () => {
    sendWeeklyNewsletters().then(({ sent }) => {
      if (sent) logger.info(`Sent ${sent} weekly Crowdwide newsletter${sent === 1 ? '' : 's'}.`);
    }).catch((error) => logger.error('Weekly newsletter delivery failed', error));
  }, { timezone });
  logger.info(`Weekly newsletter worker started (Sunday at 10:30 ${timezone}).`);
  return newsletterTask;
}

function stopNewsletterWorker() {
  if (!newsletterTask) return;
  newsletterTask.stop();
  newsletterTask = null;
}

module.exports = { NEWSLETTER_CRON, buildNewsletterSelection, sendWeeklyNewsletters, startNewsletterWorker, stopNewsletterWorker };