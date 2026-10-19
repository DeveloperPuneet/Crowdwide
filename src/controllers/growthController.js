// Public growth surfaces: the one-click reminder unsubscribe and the public
// "Question of the Day" page (a shareable, searchable door into the community).
const User = require('../models/User');
const Post = require('../models/Post');
const { verifyReminderToken } = require('../utils/unsubscribeToken');
const { questionOfTheDay, startOfDay, QUESTION_TAG } = require('../utils/questions');
const { getRestrictedCommunityIds } = require('../utils/communityPrivacy');
const logger = require('../services/logger');

const OBJECT_ID = /^[a-f0-9]{24}$/;

exports.unsubscribePage = async (req, res) => {
  const { id, token } = req.params;
  const valid = OBJECT_ID.test(id) && verifyReminderToken(id, token);
  res.status(valid ? 200 : 400).render('pages/unsubscribe', { title: 'Stop come-back reminders', noIndex: true, state: valid ? 'confirm' : 'invalid', id, token });
};

// Works as a POST from the confirm button AND as a mail client's one-click
// (RFC 8058) POST; the signed token is the only credential needed.
exports.unsubscribe = async (req, res) => {
  const { id, token } = req.params;
  if (!OBJECT_ID.test(id) || !verifyReminderToken(id, token)) {
    return res.status(400).render('pages/unsubscribe', { title: 'Stop come-back reminders', noIndex: true, state: 'invalid', id, token });
  }
  try {
    await User.updateOne({ _id: id }, { $set: { 'notificationPreferences.emailReminders': false } });
  } catch (error) {
    logger.error('Could not unsubscribe a member from reminders', error);
    return res.status(500).render('pages/unsubscribe', { title: 'Stop come-back reminders', noIndex: true, state: 'error', id, token });
  }
  return res.render('pages/unsubscribe', { title: 'You are unsubscribed', noIndex: true, state: 'done', id, token });
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
    if (viewerId) answers.forEach((post) => { post.liked = (post.likes || []).some((like) => String(like) === String(viewerId)); });
    const appUrl = String(res.locals.appUrl || process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
    res.render('pages/question', {
      title: 'Question of the Day',
      description: `${question.text} Share your answer on Crowdwide.`,
      pagePath: '/question',
      canonicalUrl: `${appUrl}/question`,
      question,
      answers,
      total
    });
  } catch (error) {
    logger.error('Unable to load the Question of the Day', error);
    res.status(500).render('pages/not-found', { title: 'Question unavailable', noIndex: true });
  }
};
