const Post = require('../models/Post');
const Comment = require('../models/Comment');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Report = require('../models/Report');

const redirectBack = (req, res, payload = {}) => {
  if (req.get('X-Requested-With') === 'XMLHttpRequest' || req.accepts('json')) return res.json({ ok: true, ...payload });
  return res.redirect(req.get('referer') || '/dashboard');
};

const canAccessPost = (post, userId) => post && (post.status !== 'draft' || String(post.author) === String(userId));

async function notify(recipient, actor, type, message, post, community) {
  if (!recipient || String(recipient) === String(actor)) return;
  const recipientUser = await User.findById(recipient).select('notificationPreferences').lean();
  const preferenceKey = type === 'like' ? 'likes' : type === 'follow' ? 'follows' : ['comment', 'reply'].includes(type) ? 'comments' : 'security';
  if (recipientUser?.notificationPreferences && recipientUser.notificationPreferences[preferenceKey] === false) return;
  await Notification.create({ recipient, actor, type, message, post, community });
}

exports.toggleLike = async (req, res) => {
  const post = await Post.findById(req.params.id);
  if (!canAccessPost(post, req.session.user.id)) return redirectBack(req, res, { ok: false });
  const alreadyLiked = post.likes.some((id) => String(id) === String(req.session.user.id));
  if (alreadyLiked) post.likes.pull(req.session.user.id);
  else {
    post.likes.addToSet(req.session.user.id);
    await notify(post.author, req.session.user.id, 'like', 'liked your post.', post._id, post.community);
  }
  await post.save();
  redirectBack(req, res, { liked: !alreadyLiked, likes: post.likes.length });
};

exports.reportPost = async (req, res) => {
  const post = await Post.findById(req.params.id).select('_id author status').lean();
  if (!canAccessPost(post, req.session.user.id)) return redirectBack(req, res, { reported: false });
  const reason = req.body.reason?.trim();
  if (post && reason) {
    await Report.updateOne(
      { reporter: req.session.user.id, targetType: 'post', target: post._id },
      { $setOnInsert: { reporter: req.session.user.id, targetType: 'post', target: post._id, reason } },
      { upsert: true }
    );
  }
  return redirectBack(req, res, { reported: Boolean(post && reason) });
};

exports.editPost = async (req, res) => {
  const body = req.body.body?.trim();
  const post = await Post.findOne({ _id: req.params.id, author: req.session.user.id });
  if (!post) return redirectBack(req, res, { ok: false, error: 'Post not found or you do not own it.' });
  const wordLimit = post.type === 'article' ? 550 : 120;
  const wordCount = body ? body.split(/\s+/).filter(Boolean).length : 0;
  if (!body || wordCount > wordLimit) return redirectBack(req, res, { ok: false, error: `${post.type === 'article' ? 'Articles' : 'Posts'} are limited to ${wordLimit} words.` });
  post.body = body;
  await post.save();
  return redirectBack(req, res, { edited: true });
};

exports.deletePost = async (req, res) => {
  const post = await Post.findOneAndDelete({ _id: req.params.id, author: req.session.user.id });
  if (!post) return redirectBack(req, res, { ok: false, error: 'Post not found or you do not own it.' });
  await Comment.deleteMany({ post: post._id });
  return redirectBack(req, res, { deleted: true });
};

exports.comment = async (req, res) => {
  const body = req.body.body?.trim();
  const post = await Post.findById(req.params.id);
  if (!canAccessPost(post, req.session.user.id) || !body || body.length > 2000) return redirectBack(req, res, { ok: false, error: 'Comment must be between 1 and 2,000 characters.' });
  const comment = await Comment.create({ post: post._id, author: req.session.user.id, body, parent: req.body.parent || null });
  post.commentsCount += 1;
  await post.save();
  await notify(post.author, req.session.user.id, req.body.parent ? 'reply' : 'comment', req.body.parent ? 'replied to your comment.' : 'commented on your post.', post._id, post.community);
  if (req.get('X-Requested-With') === 'XMLHttpRequest' || req.accepts('json')) return res.json({ ok: true, comment: { id: comment._id, body: comment.body } });
  res.redirect(`${req.get('referer') || `/dashboard`}#post-${post._id}`);
};

exports.editComment = async (req, res) => {
  const body = req.body.body?.trim();
  const comment = await Comment.findOne({ _id: req.params.id, author: req.session.user.id });
  if (!comment) return redirectBack(req, res, { ok: false, error: 'Comment not found or you do not own it.' });
  if (!body || body.length > 2000) return redirectBack(req, res, { ok: false, error: 'Comment must be between 1 and 2,000 characters.' });
  comment.body = body;
  await comment.save();
  return redirectBack(req, res, { edited: true });
};

exports.deleteComment = async (req, res) => {
  const comment = await Comment.findOneAndDelete({ _id: req.params.id, author: req.session.user.id });
  if (!comment) return redirectBack(req, res, { ok: false, error: 'Comment not found or you do not own it.' });
  const descendants = await Comment.deleteMany({ parent: comment._id });
  const post = await Post.findById(comment.post);
  if (post) {
    post.commentsCount = Math.max(0, (post.commentsCount || 0) - 1 - descendants.deletedCount);
    await post.save();
  }
  return redirectBack(req, res, { deleted: true });
};

exports.toggleCommentLike = async (req, res) => {
  const comment = await Comment.findById(req.params.id).populate('post', 'author status');
  if (!comment || !canAccessPost(comment.post, req.session.user.id)) return redirectBack(req, res, { ok: false });
  const alreadyLiked = comment.likes.some((id) => String(id) === String(req.session.user.id));
  if (alreadyLiked) comment.likes.pull(req.session.user.id);
  else comment.likes.addToSet(req.session.user.id);
  await comment.save();
  return redirectBack(req, res, { liked: !alreadyLiked, likes: comment.likes.length });
};

exports.toggleBookmark = async (req, res) => {
  const post = await Post.findById(req.params.id).select('author status').lean();
  if (!canAccessPost(post, req.session.user.id)) return redirectBack(req, res, { ok: false });
  const user = await User.findById(req.session.user.id);
  if (!user) return redirectBack(req, res);
  const exists = user.bookmarks.some((id) => String(id) === req.params.id);
  if (exists) user.bookmarks.pull(req.params.id);
  else user.bookmarks.addToSet(req.params.id);
  await user.save();
  redirectBack(req, res, { bookmarked: !exists });
};

exports.share = async (req, res) => {
  const post = await Post.findOneAndUpdate({ _id: req.params.id, $or: [{ status: { $ne: 'draft' } }, { author: req.session.user.id }] }, { $inc: { sharesCount: 1 } }, { new: true });
  if (post) await notify(post.author, req.session.user.id, 'comment', 'shared your post.', post._id, post.community);
  if (req.get('X-Requested-With') !== 'XMLHttpRequest') return redirectBack(req, res);
  res.json({ url: `${process.env.APP_URL || 'http://localhost:3000'}/posts/${req.params.id}`, shares: post?.sharesCount || 0 });
};

exports.votePoll = async (req, res) => {
  const post = await Post.findById(req.params.id);
  const optionIndex = Number(req.body.optionIndex);
  if (!canAccessPost(post, req.session.user.id) || !post.poll?.options?.[optionIndex]) return redirectBack(req, res, { ok: false, error: 'That poll is unavailable.' });
  const alreadyVoted = post.poll.options.some((option) => option.votes.some((id) => String(id) === String(req.session.user.id)));
  if (!alreadyVoted) post.poll.options[optionIndex].votes.addToSet(req.session.user.id);
  await post.save();
  return redirectBack(req, res, { voted: !alreadyVoted });
};

function buildCommentTree(comments) {
  const byId = new Map(comments.map((comment) => [String(comment._id), { ...comment, children: [] }]));
  const roots = [];
  byId.forEach((comment) => {
    if (comment.parent && byId.has(String(comment.parent))) {
      byId.get(String(comment.parent)).children.push(comment);
    } else {
      roots.push(comment);
    }
  });
  return roots;
}

exports.postDetail = async (req, res) => {
  const viewerId = req.session.user?.id;
  const post = await Post.findOneAndUpdate({ _id: req.params.id, $or: [{ status: { $ne: 'draft' } }, { author: viewerId || null }] }, { $inc: { viewsCount: 1 } }, { new: true })
    .populate('author', 'name profilePicture')
    .populate('community', 'name slug')
    .lean();
  if (!post) return res.status(404).render('pages/not-found', { title: 'Post not found' });
  let blockedIds = [];
  if (viewerId) {
    const viewer = await User.findById(viewerId).select('bookmarks blockedUsers').lean();
    post.liked = (post.likes || []).some((id) => String(id) === String(viewerId));
    post.bookmarked = (viewer?.bookmarks || []).some((id) => String(id) === String(post._id));
    blockedIds = (viewer?.blockedUsers || []).map(String);
  }
  const comments = (await Comment.find({ post: post._id }).sort({ createdAt: 1 }).populate('author', 'name profilePicture').lean())
    .filter((comment) => !blockedIds.includes(String(comment.author?._id)));
  const commentTree = buildCommentTree(comments);
  res.render('pages/post-detail', { title: `${post.author?.name || 'Crowdwide'} post`, pagePath: `/posts/${post._id}`, noIndex: false, post, comments, commentTree });
};

exports.commentThread = async (req, res) => {
  const post = await Post.findById(req.params.id).select('author status').lean();
  if (!canAccessPost(post, req.session.user?.id)) return res.status(404).json({ comments: [] });
  const comments = await Comment.find({ post: req.params.id }).sort({ createdAt: 1 }).populate('author', 'name profilePicture').lean();
  res.json({ comments });
};

exports.notifications = async (req, res) => {
  const viewer = await User.findById(req.session.user.id).select('blockedUsers').lean();
  const [notificationsRaw, unread] = await Promise.all([
    Notification.find({ recipient: req.session.user.id }).sort({ createdAt: -1 }).limit(50).populate('actor', 'name profilePicture').lean(),
    Notification.countDocuments({ recipient: req.session.user.id, readAt: null })
  ]);
  const blockedIds = (viewer?.blockedUsers || []).map(String);
  const notifications = notificationsRaw.filter((notification) => !notification.actor || !blockedIds.includes(String(notification.actor._id)));
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

exports.toggleBlock = async (req, res) => {
  const targetId = req.params.id;
  if (targetId === String(req.session.user.id)) return redirectBack(req, res, { ok: false });
  const user = await User.findById(req.session.user.id);
  if (!user) return redirectBack(req, res, { ok: false });
  const alreadyBlocked = user.blockedUsers.some((id) => String(id) === targetId);
  if (alreadyBlocked) {
    user.blockedUsers.pull(targetId);
  } else {
    user.blockedUsers.addToSet(targetId);
    user.following.pull(targetId);
  }
  await user.save();
  redirectBack(req, res, { blocked: !alreadyBlocked });
};

exports.toggleFollow = async (req, res) => {
  const targetId = req.params.id;
  if (targetId === String(req.session.user.id)) return redirectBack(req, res, { ok: false });
  const [user, target] = await Promise.all([
    User.findById(req.session.user.id),
    User.findById(targetId).select('_id blockedUsers')
  ]);
  if (!user || !target) return redirectBack(req, res, { ok: false });
  if (target.blockedUsers.some((id) => String(id) === String(user._id))) return redirectBack(req, res, { ok: false });
  const alreadyFollowing = user.following.some((id) => String(id) === targetId);
  if (alreadyFollowing) {
    user.following.pull(targetId);
  } else {
    user.following.addToSet(targetId);
    await notify(target._id, user._id, 'follow', 'started following you.');
  }
  await user.save();
  const followersCount = await User.countDocuments({ following: targetId });
  redirectBack(req, res, { following: !alreadyFollowing, followersCount });
};
