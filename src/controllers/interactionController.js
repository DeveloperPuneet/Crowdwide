const Post = require('../models/Post');
const Comment = require('../models/Comment');
const Notification = require('../models/Notification');
const User = require('../models/User');

const redirectBack = (req, res, payload = {}) => {
  if (req.get('X-Requested-With') === 'XMLHttpRequest' || req.accepts('json')) return res.json({ ok: true, ...payload });
  return res.redirect(req.get('referer') || '/dashboard');
};

async function notify(recipient, actor, type, message, post, community) {
  if (!recipient || String(recipient) === String(actor)) return;
  await Notification.create({ recipient, actor, type, message, post, community });
}

exports.toggleLike = async (req, res) => {
  const post = await Post.findById(req.params.id);
  if (!post) return redirectBack(req, res);
  const alreadyLiked = post.likes.some((id) => String(id) === String(req.session.user.id));
  if (alreadyLiked) post.likes.pull(req.session.user.id);
  else {
    post.likes.addToSet(req.session.user.id);
    await notify(post.author, req.session.user.id, 'like', 'liked your post.', post._id, post.community);
  }
  await post.save();
  redirectBack(req, res, { liked: !alreadyLiked, likes: post.likes.length });
};

exports.comment = async (req, res) => {
  const body = req.body.body?.trim();
  const post = await Post.findById(req.params.id);
  if (!post || !body || body.length > 2000) return redirectBack(req, res, { ok: false, error: 'Comment must be between 1 and 2,000 characters.' });
  const comment = await Comment.create({ post: post._id, author: req.session.user.id, body, parent: req.body.parent || null });
  post.commentsCount += 1;
  await post.save();
  await notify(post.author, req.session.user.id, req.body.parent ? 'reply' : 'comment', req.body.parent ? 'replied to your comment.' : 'commented on your post.', post._id, post.community);
  if (req.get('X-Requested-With') === 'XMLHttpRequest' || req.accepts('json')) return res.json({ ok: true, comment: { id: comment._id, body: comment.body } });
  res.redirect(`${req.get('referer') || `/dashboard`}#post-${post._id}`);
};

exports.toggleBookmark = async (req, res) => {
  const user = await User.findById(req.session.user.id);
  if (!user) return redirectBack(req, res);
  const exists = user.bookmarks.some((id) => String(id) === req.params.id);
  if (exists) user.bookmarks.pull(req.params.id);
  else user.bookmarks.addToSet(req.params.id);
  await user.save();
  redirectBack(req, res, { bookmarked: !exists });
};

exports.share = async (req, res) => {
  const post = await Post.findByIdAndUpdate(req.params.id, { $inc: { sharesCount: 1 } }, { new: true });
  if (post) await notify(post.author, req.session.user.id, 'comment', 'shared your post.', post._id, post.community);
  if (req.get('X-Requested-With') !== 'XMLHttpRequest') return redirectBack(req, res);
  res.json({ url: `${process.env.APP_URL || 'http://localhost:3000'}/posts/${req.params.id}`, shares: post?.sharesCount || 0 });
};

exports.postDetail = async (req, res) => {
  const post = await Post.findById(req.params.id).populate('author', 'name').populate('community', 'name slug').lean();
  if (!post) return res.status(404).render('pages/not-found', { title: 'Post not found' });
  const comments = await Comment.find({ post: post._id }).sort({ createdAt: 1 }).populate('author', 'name').lean();
  res.render('pages/post-detail', { title: `${post.author?.name || 'Crowdwide'} post`, pagePath: `/posts/${post._id}`, noIndex: false, post, comments });
};

exports.notifications = async (req, res) => {
  const [notifications, unread] = await Promise.all([
    Notification.find({ recipient: req.session.user.id }).sort({ createdAt: -1 }).limit(50).populate('actor', 'name').lean(),
    Notification.countDocuments({ recipient: req.session.user.id, readAt: null })
  ]);
  res.render('pages/notifications', { title: 'Notifications', pagePath: '/notifications', noIndex: true, notifications, unread });
};

exports.unreadCount = async (req, res) => {
  const unread = await Notification.countDocuments({ recipient: req.session.user.id, readAt: null });
  res.json({ unread });
};

exports.readNotifications = async (req, res) => {
  await Notification.updateMany({ recipient: req.session.user.id, readAt: null }, { readAt: new Date() });
  res.redirect('/notifications');
};
