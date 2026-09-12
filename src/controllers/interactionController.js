const Post = require('../models/Post');
const Community = require('../models/Community');
const Comment = require('../models/Comment');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Report = require('../models/Report');
const Message = require('../models/Message');
const { extractHashtags } = require('../utils/hashtags');
const { notifyMentionedUsers } = require('../services/mentions');

const redirectBack = (req, res, payload = {}) => {
  if (req.get('X-Requested-With') === 'XMLHttpRequest') return res.json({ ok: true, ...payload });
  return res.redirect(req.get('referer') || '/dashboard');
};

const canAccessPost = (post, userId) => post && (!['draft', 'scheduled'].includes(post.status) || String(post.author) === String(userId));

async function notify(recipient, actor, type, message, post, community) {
  if (!recipient || String(recipient) === String(actor)) return;
  const recipientUser = await User.findById(recipient).select('notificationPreferences').lean();
  const preferenceKey = type === 'like' ? 'likes' : type === 'follow' ? 'follows' : ['comment', 'reply', 'mention'].includes(type) ? 'comments' : 'security';
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
  await notifyMentionedUsers(body, req.session.user.id, post._id, post.community, 'mentioned you in a comment.');
  if (req.get('X-Requested-With') === 'XMLHttpRequest') return res.json({ ok: true, comment: { id: comment._id, body: comment.body } });
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
  const post = await Post.findOneAndUpdate({ _id: req.params.id, $or: [{ status: { $nin: ['draft', 'scheduled'] } }, { author: req.session.user.id }] }, { $inc: { sharesCount: 1 } }, { new: true });
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

exports.quotePost = async (req, res) => {
  const source = await Post.findById(req.params.id).select('author status body').lean();
  const body = req.body.body?.trim();
  if (!canAccessPost(source, req.session.user.id) || !body || body.length > 4000) {
    req.session.flash = { type: 'error', message: 'Add commentary before quoting that post.' };
    return res.redirect(req.get('referer') || '/dashboard');
  }
  await Post.create({ author: req.session.user.id, body, type: 'post', quotedPost: source._id, hashtags: extractHashtags(body), status: 'published' });
  await notify(source.author, req.session.user.id, 'comment', 'quoted your post.', source._id);
  res.redirect(req.get('referer') || '/dashboard');
};

exports.toggleReaction = async (req, res) => {
  const reactionTypes = ['celebrate', 'insightful', 'support', 'funny'];
  const reaction = req.body.reaction;
  const post = await Post.findById(req.params.id);
  if (!canAccessPost(post, req.session.user.id) || !reactionTypes.includes(reaction)) return redirectBack(req, res, { ok: false });
  const reactions = post.reactions?.toObject ? post.reactions.toObject() : { ...(post.reactions || {}) };
  reactionTypes.forEach((type) => {
    const users = Array.isArray(reactions[type]) ? reactions[type].map(String) : [];
    reactions[type] = users.filter((id) => id !== String(req.session.user.id));
  });
  const hadReaction = (post.reactions?.[reaction] || []).some((id) => String(id) === String(req.session.user.id));
  if (!hadReaction) reactions[reaction].push(req.session.user.id);
  post.set('reactions', reactions);
  await post.save();
  return redirectBack(req, res, { reaction: hadReaction ? null : reaction });
};

exports.replyPost = async (req, res) => {
  const source = await Post.findById(req.params.id).select('author status community body').lean();
  const body = req.body.body?.trim();
  if (!canAccessPost(source, req.session.user.id) || !body || body.length > 4000) return redirectBack(req, res, { ok: false, error: 'Replies must include 1 to 4,000 characters.' });
  if (source.community) {
    const community = await Community.findById(source.community).select('members bannedWords');
    if (!community?.members.some((id) => String(id) === String(req.session.user.id))) return redirectBack(req, res, { ok: false, error: 'Join the community before replying to this post.' });
    const bodyLower = body.toLowerCase();
    if ((community.bannedWords || []).some((word) => word && bodyLower.includes(word))) return redirectBack(req, res, { ok: false, error: 'That reply contains a word this community has blocked.' });
  }
  const reply = await Post.create({ author: req.session.user.id, body, type: 'post', community: source.community, replyTo: source._id, hashtags: extractHashtags(body), status: 'published' });
  await notify(source.author, req.session.user.id, 'comment', 'replied to your post.', source._id, source.community);
  return redirectBack(req, res, { reply: { id: reply._id, body: reply.body } });
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
  const post = await Post.findOneAndUpdate({ _id: req.params.id, $or: [{ status: { $nin: ['draft', 'scheduled'] } }, { author: viewerId || null }] }, { $inc: { viewsCount: 1 } }, { new: true })
    .populate('author', 'name profilePicture')
    .populate('community', 'name slug')
    .populate({ path: 'quotedPost', select: 'body author', populate: { path: 'author', select: 'name profilePicture' } })
    .populate({ path: 'replyTo', select: 'body author', populate: { path: 'author', select: 'name profilePicture' } })
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
  const visibleNotifications = notificationsRaw.filter((notification) => !notification.actor || !blockedIds.includes(String(notification.actor._id)));
  const grouped = new Map();
  visibleNotifications.forEach((notification) => {
    const key = [notification.type, notification.post || '', notification.community || ''].join(':');
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
      existing.readAt = existing.readAt && notification.readAt ? existing.readAt : null;
    } else {
      grouped.set(key, { ...notification, count: 1 });
    }
  });
  const notifications = Array.from(grouped.values());
  res.render('pages/notifications', { title: 'Notifications', pagePath: '/notifications', noIndex: true, notifications, unread });
};

exports.unreadCount = async (req, res) => {
  const unread = await Notification.countDocuments({ recipient: req.session.user.id, readAt: null });
  res.json({ unread });
};

exports.messages = async (req, res) => {
  const userId = req.session.user.id;
  const messages = await Message.find({ $or: [{ sender: userId }, { recipient: userId }] })
    .sort({ createdAt: -1 }).limit(300)
    .populate('sender', 'name profilePicture').populate('recipient', 'name profilePicture').lean();
  const conversations = new Map();
  messages.forEach((message) => {
    const other = String(message.sender._id) === String(userId) ? message.recipient : message.sender;
    const key = String(other._id);
    if (!conversations.has(key)) conversations.set(key, { person: other, latest: message, unread: 0 });
    if (String(message.recipient._id) === String(userId) && !message.readAt) conversations.get(key).unread += 1;
  });
  res.render('pages/messages', { title: 'Messages', pagePath: '/messages', noIndex: true, conversations: Array.from(conversations.values()) });
};

exports.messageThread = async (req, res) => {
  const userId = req.session.user.id;
  const person = await User.findById(req.params.id).select('name profilePicture blockedUsers').lean();
  if (!person || String(person._id) === String(userId)) return res.redirect('/messages');
  const viewer = await User.findById(userId).select('blockedUsers').lean();
  const blocked = (viewer?.blockedUsers || []).some((id) => String(id) === String(person._id)) || (person.blockedUsers || []).some((id) => String(id) === String(userId));
  if (blocked) {
    req.session.flash = { type: 'error', message: 'Messaging is unavailable for this account.' };
    return res.redirect('/messages');
  }
  await Message.updateMany({ sender: person._id, recipient: userId, readAt: null }, { readAt: new Date() });
  const thread = await Message.find({ $or: [{ sender: userId, recipient: person._id }, { sender: person._id, recipient: userId }] })
    .sort({ createdAt: 1 }).limit(100).populate('sender', 'name profilePicture').lean();
  res.render('pages/message-thread', { title: `Messages with ${person.name}`, pagePath: `/messages/${person._id}`, noIndex: true, person, thread });
};

exports.sendMessage = async (req, res) => {
  const userId = req.session.user.id;
  const body = req.body.body?.trim();
  const recipient = await User.findById(req.params.id).select('_id isVerified blockedUsers').lean();
  const viewer = await User.findById(userId).select('blockedUsers').lean();
  const blocked = recipient && ((viewer?.blockedUsers || []).some((id) => String(id) === String(recipient._id)) || (recipient.blockedUsers || []).some((id) => String(id) === String(userId)));
  if (!recipient || !recipient.isVerified || blocked || !body || body.length > 2000) {
    req.session.flash = { type: 'error', message: 'That message could not be sent.' };
    return res.redirect(`/messages/${req.params.id}`);
  }
  await Message.create({ sender: userId, recipient: recipient._id, body });
  res.redirect(`/messages/${recipient._id}`);
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
