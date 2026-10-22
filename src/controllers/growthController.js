// Public growth surfaces: the one-click reminder unsubscribe and the public
// "Question of the Day" page (a shareable, searchable door into the community).
const User = require('../models/User');
const Post = require('../models/Post');
const { verifyToken, KINDS } = require('../utils/unsubscribeToken');
const { questionOfTheDay, startOfDay, QUESTION_TAG } = require('../utils/questions');
const { getRestrictedCommunityIds } = require('../utils/communityPrivacy');
const { getWeeklyTop } = require('../services/weeklyTop');
const { attachReplyPostCounts } = require('../services/replyPostCounts');
const logger = require('../services/logger');

const OBJECT_ID = /^[a-f0-9]{24}$/;

exports.unsubscribePage = async (req, res) => {
  const { kind, id, token } = req.params;
  const valid = OBJECT_ID.test(id) && verifyToken(kind, id, token);
  res.status(valid ? 200 : 400).render('pages/unsubscribe', { title: 'Email preferences', noIndex: true, state: valid ? 'confirm' : 'invalid', id, token, kind: Object.hasOwn(KINDS, kind) ? kind : 'reminders' });
};

// Works as a POST from the confirm button AND as a mail client's one-click
// (RFC 8058) POST; the signed token is the only credential needed.
exports.unsubscribe = async (req, res) => {
  const { kind, id, token } = req.params;
  const view = (state, extra = {}) => ({ title: state === 'done' ? 'You are unsubscribed' : 'Email preferences', noIndex: true, state, id, token, kind: Object.hasOwn(KINDS, kind) ? kind : 'reminders', ...extra });
  if (!OBJECT_ID.test(id) || !verifyToken(kind, id, token)) return res.status(400).render('pages/unsubscribe', view('invalid'));
  try {
    await User.updateOne({ _id: id }, { $set: { [`notificationPreferences.${KINDS[kind]}`]: false } });
  } catch (error) {
    logger.error('Could not unsubscribe a member', error);
    return res.status(500).render('pages/unsubscribe', view('error'));
  }
  return res.render('pages/unsubscribe', view('done'));
};

exports.questionPage = async (req, res) => {
  try {
    const now = new Date();
    const question = questionOfTheDay(now);
    const restricted = await getRestrictedCommunityIds(null);
    const filter = { hashtags: QUESTION_TAG, status: 'published', moderationStatus: { $ne: 'reported' }, community: { $nin: restricted }, createdAt: { $gte: startOfDay(now) } };
    const [answers, total] = await Promise.all([
      Post.find(filter).sort({ createdAt: -1 }).limit(20)
        .populate('author', 'name profilePicture')
        .populate('community', 'name slug isPrivate')
        .lean(),
      Post.countDocuments(filter)
    ]);
    const viewerId = req.session?.user?.id;
    const answersWithReplyCounts = await attachReplyPostCounts(answers);
    if (viewerId) answersWithReplyCounts.forEach((post) => { post.liked = (post.likes || []).some((like) => String(like) === String(viewerId)); });
    const appUrl = String(res.locals.appUrl || process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
    res.render('pages/question', {
      title: 'Question of the Day',
      description: `${question.text} Share your answer on Crowdwide.`,
      pagePath: '/question',
      canonicalUrl: `${appUrl}/question`,
      question,
      answers: answersWithReplyCounts,
      total
    });
  } catch (error) {
    logger.error('Unable to load the Question of the Day', error);
    res.status(500).render('pages/not-found', { title: 'Question unavailable', noIndex: true });
  }
};

const formatDay = (date) => new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

exports.weeklyTopPage = async (req, res) => {
  try {
    const data = await getWeeklyTop();
    const viewerId = req.session?.user?.id;
    const mark = (post) => ({ ...post, liked: viewerId ? (post.likes || []).some((like) => String(like) === String(viewerId)) : false });
    const [topPosts, articles, discussed] = await Promise.all([
      attachReplyPostCounts(data.top),
      attachReplyPostCounts(data.articles),
      attachReplyPostCounts(data.discussed)
    ]);
    const appUrl = String(res.locals.appUrl || process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
    const lead = data.top[0];
    const leadText = lead ? String(lead.type === 'poll' && lead.poll?.question ? lead.poll.question : lead.body || '').replace(/\s+/g, ' ').slice(0, 110) : '';
    const range = `${formatDay(data.from)} - ${formatDay(data.to)}`;
    const description = lead
      ? `The best of Crowdwide this week (${range}): ${leadText}${leadText.length >= 110 ? '...' : ''} Plus the top discussions, creators and communities.`
      : `The best of Crowdwide this week (${range}): top posts, discussions, creators and communities.`;
    res.render('pages/top', {
      title: 'This week on Crowdwide',
      description,
      pagePath: '/top',
      canonicalUrl: `${appUrl}/top`,
      shareUrl: `${appUrl}/top`,
      shareText: 'The best conversations on Crowdwide this week',
      range,
      top: topPosts.map(mark),
      articles: articles.map(mark),
      discussed: discussed.map(mark),
      creators: data.creators,
      communities: data.communities,
      totals: data.totals,
      structuredData: {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: 'This week on Crowdwide',
        description,
        url: `${appUrl}/top`,
        mainEntity: { '@type': 'ItemList', itemListElement: data.top.map((post, index) => ({ '@type': 'ListItem', position: index + 1, url: `${appUrl}/posts/${post._id}` })) }
      }
    });
  } catch (error) {
    logger.error('Unable to load the weekly top page', error);
    res.status(500).render('pages/not-found', { title: 'Top posts unavailable', noIndex: true });
  }
};
