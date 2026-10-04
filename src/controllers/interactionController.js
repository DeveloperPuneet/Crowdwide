const Post = require('../models/Post');
const Community = require('../models/Community');
const Comment = require('../models/Comment');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Report = require('../models/Report');
const Message = require('../models/Message');
const { previewText } = require('../services/chat');
const { extractHashtags } = require('../utils/hashtags');
const countWords = require('../utils/wordCount');
const { gifFromBody } = require('../services/gif');
const { refreshPersonalization } = require('../services/feedService');
const { notifyMentionedUsers } = require('../services/mentions');
const { sendPushToUser } = require('../services/push');
const { checkPostingRestriction } = require('../utils/postingRestriction');
const { uploadBuffer, mediaUrl } = require('../services/storageCluster');
const { createImageThumbnail, getImageSize } = require('../services/storage');
const { mediaDetailsFor } = require('../utils/mediaDetails');
const { getWordLimits } = require('../services/siteConfig');
const { toggleReaction } = require('../utils/reactions');
const logger = require('../services/logger');
const { sendUnreadNotificationSummary } = require('../services/mailer');
const { notificationPreferenceAllows } = require('../utils/notificationPreferences');

const MAX_REPLY_POST_WORDS = 50;

const redirectBack = (req, res, payload = {}) => {
  if (req.get('X-Requested-With') === 'XMLHttpRequest') return res.json({ ok: true, ...payload });
  return res.redirect(req.get('referer') || '/dashboard');
};

const canAccessPost = async (post, userId) => {
  if (!post) return false;
  if (['draft', 'scheduled'].includes(post.status) && String(post.author) !== String(userId)) return false;
  if (post.community) {
    const restricted = await Community.exists({ _id: post.community, isPrivate: true, members: { $ne: userId } });
    if (restricted) return false;
  }
  return true;
};
exports.canAccessPost = canAccessPost;

async function notify(recipient, actor, type, message, post, community, actorName, url) {
  if (!recipient || String(recipient) === String(actor)) return;
  const recipientUser = await User.findById(recipient).select('name email notificationPreferences').lean();
  const preferenceKey = type === 'like' ? 'likes' : type === 'follow' ? 'follows' : type === 'message' ? 'messages' : ['comment', 'reply', 'mention'].includes(type) ? 'comments' : 'security';
  if (!notificationPreferenceAllows(recipientUser?.notificationPreferences, preferenceKey, type)) return;
  await Notification.create({ recipient, actor, type, message, post, community });
  if (recipientUser?.notificationPreferences?.emailUnreadSummary !== false) {
    const unread = await Notification.countDocuments({ recipient, readAt: null });
    if (unread >= 5) {
      const claim = await User.updateOne({
        _id: recipient,
        'notificationPreferences.emailUnreadSummary': { $ne: false },
        $or: [{ unreadSummarySentAt: null }, { unreadSummarySentAt: { $exists: false } }]
      }, { $set: { unreadSummarySentAt: new Date() } });
      if (claim.modifiedCount) {
        const summary = await Notification.find({ recipient, readAt: null }).sort({ createdAt: -1 }).limit(5).populate('actor', 'name').lean();
        sendUnreadNotificationSummary(recipientUser, summary).catch((error) => logger.error('Unread notification email failed', error));
      }
    }
  }
  sendPushToUser(recipient, {
    title: 'Crowdwide',
    body: actorName ? `${actorName} ${message}` : message,
    url: url || (post ? `/posts/${post}` : '/notifications')
  }).catch((error) => logger.error('Push notification failed', error));
}
exports.notify = notify;

exports.toggleLike = async (req, res) => {
  const post = await Post.findById(req.params.id);
  if (!(await canAccessPost(post, req.session.user.id))) return redirectBack(req, res, { ok: false });
  const alreadyLiked = post.likes.some((id) => String(id) === String(req.session.user.id));
  if (alreadyLiked) post.likes.pull(req.session.user.id);
  else {
    post.likes.addToSet(req.session.user.id);
    await notify(post.author, req.session.user.id, 'like', 'liked your post.', post._id, post.community, req.session.user.name);
    refreshPersonalization(req.session.user.id); // a new like should shape "for you" on the very next load, not up to 5 minutes later
  }
  await post.save();
  redirectBack(req, res, { liked: !alreadyLiked, likes: post.likes.length });
};

exports.reportPost = async (req, res) => {
  const post = await Post.findById(req.params.id).select('_id author status community').lean();
  if (!(await canAccessPost(post, req.session.user.id))) return redirectBack(req, res, { reported: false });
  const reason = req.body.reason?.trim();
  if (post && reason) {
    let evidenceUrl;
    if (req.file) {
      const stored = await uploadBuffer(req.file.buffer, req.file.originalname, req.file.mimetype, { kind: 'report-evidence', owner: req.session.user.id });
      evidenceUrl = mediaUrl(stored);
    }
    await Report.updateOne(
      { reporter: req.session.user.id, targetType: 'post', target: post._id },
      { $setOnInsert: { reporter: req.session.user.id, targetType: 'post', target: post._id, reason, evidenceUrl } },
      { upsert: true }
    );
  }
  return redirectBack(req, res, { reported: Boolean(post && reason) });
};

exports.reportComment = async (req, res) => {
  const comment = await Comment.findById(req.params.id).populate('post', 'author status community').lean();
  if (!comment || !comment.post || !(await canAccessPost(comment.post, req.session.user.id))) return redirectBack(req, res, { reported: false });
  const reason = String(req.body.reason || '').trim().slice(0, 500);
  if (!reason) {
    req.session.flash = { type: 'error', message: 'Choose a reason to report this comment.' };
    return res.redirect(`/posts/${comment.post._id}#comment-${comment._id}`);
  }
  if (String(comment.author) === String(req.session.user.id)) {
    req.session.flash = { type: 'error', message: 'You cannot report your own comment.' };
    return res.redirect(`/posts/${comment.post._id}#comment-${comment._id}`);
  }
  const contextText = `Comment: ${comment.body || '[GIF comment]'}`.slice(0, 3000);
  await Report.updateOne(
    { reporter: req.session.user.id, targetType: 'comment', target: comment._id },
    { $setOnInsert: { reporter: req.session.user.id, targetType: 'comment', target: comment._id, reason, contextText } },
    { upsert: true }
  );
  req.session.flash = { type: 'success', message: 'Comment reported to the moderation team.' };
  return res.redirect(`/posts/${comment.post._id}#comment-${comment._id}`);
};

exports.editPost = async (req, res) => {
  const body = req.body.body?.trim();
  const post = await Post.findOne({ _id: req.params.id, author: req.session.user.id });
  if (!post) return redirectBack(req, res, { ok: false, error: 'Post not found or you do not own it.' });
  const wordLimits = await getWordLimits();
  const wordLimit = post.replyTo ? MAX_REPLY_POST_WORDS : post.type === 'article' ? wordLimits.article : wordLimits.post;
  const wordCount = countWords(body);
  const existingWordCount = countWords(post.body);
  if (!body || (wordCount > wordLimit && wordCount > existingWordCount)) {
    const error = `${post.type === 'article' ? 'Articles' : 'Posts'} are limited to ${wordLimit} words.`;
    req.session.flash = { type: 'error', message: error };
    return redirectBack(req, res, { ok: false, error });
  }
  post.body = body;
  await post.save();
  if (req.get('X-Requested-With') === 'XMLHttpRequest') return res.json({ ok: true, edited: true });
  return res.redirect(`/posts/${post._id}`);
};

exports.editPostPage = async (req, res) => {
  const post = await Post.findOne({ _id: req.params.id, author: req.session.user.id })
    .populate('author', 'name profilePicture')
    .populate('community', 'name slug')
    .lean();
  if (!post) {
    req.session.flash = { type: 'error', message: 'Post not found or you do not own it.' };
    return res.redirect(`/posts/${req.params.id}`);
  }
  const limits = await getWordLimits();
  res.render('pages/post-compose', {
    title: 'Edit post',
    pagePath: `/posts/${post._id}/edit`,
    noIndex: true,
    editorMode: 'edit',
    post,
    sourcePost: post,
    wordLimit: post.replyTo ? MAX_REPLY_POST_WORDS : post.type === 'article' ? limits.article : limits.post
  });
};

exports.deletePost = async (req, res) => {
  const post = await Post.findOneAndDelete({ _id: req.params.id, author: req.session.user.id });
  if (!post) return redirectBack(req, res, { ok: false, error: 'Post not found or you do not own it.' });
  await Comment.deleteMany({ post: post._id });
  return redirectBack(req, res, { deleted: true });
};

function renderPartial(res, view, data) {
  return new Promise((resolve, reject) => res.render(view, data, (error, html) => (error ? reject(error) : resolve(html))));
}

exports.comment = async (req, res) => {
  const restriction = await checkPostingRestriction(req.session.user.id);
  if (restriction) return redirectBack(req, res, { ok: false, error: restriction });
  const body = String(req.body.body || '').trim();
  const gif = gifFromBody(req.body);
  const post = await Post.findById(req.params.id);
  if (!(await canAccessPost(post, req.session.user.id)) || (!body && !gif) || body.length > 2000) return redirectBack(req, res, { ok: false, error: 'Add a comment (up to 2,000 characters) or pick a GIF.' });
  let parent = null;
  let replyRecipient = null;
  if (req.body.parent) {
    // A reply's parent must be a comment on this same post.
    const parentComment = /^[a-f\d]{24}$/i.test(String(req.body.parent))
      ? await Comment.findOne({ _id: req.body.parent, post: post._id }).select('author').lean()
      : null;
    if (!parentComment) return redirectBack(req, res, { ok: false, error: 'That comment is no longer available.' });
    parent = req.body.parent;
    replyRecipient = parentComment.author;
  }
  const comment = await Comment.create({ post: post._id, author: req.session.user.id, body, parent, ...(gif ? { gif } : {}) });
  post.commentsCount += 1;
  await post.save();
  refreshPersonalization(req.session.user.id);
  await notify(replyRecipient || post.author, req.session.user.id, parent ? 'reply' : 'comment', parent ? 'replied to your comment.' : 'commented on your post.', post._id, post.community, req.session.user.name);
  if (body) await notifyMentionedUsers(body, req.session.user.id, post._id, post.community, 'mentioned you in a comment.');
  if (req.get('X-Requested-With') === 'XMLHttpRequest') {
    // Send the finished comment back as HTML so the page can drop it into the
    // thread without reloading.
    const node = { ...comment.toObject(), author: { _id: req.session.user.id, name: req.session.user.name, profilePicture: req.session.user.profilePicture }, children: [] };
    const html = await renderPartial(res, 'partials/comment-node', { node, depth: parent ? 1 : 0, postId: post._id, postAuthorId: post.author, csrfToken: res.locals.csrfToken, canReply: true });
    return res.json({ ok: true, html: html.trim(), id: comment._id, parent, commentsCount: post.commentsCount });
  }
  res.redirect(`${req.get('referer') || '/dashboard'}#post-${post._id}`);
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
  const comment = await Comment.findById(req.params.id).populate('post', 'author status community');
  if (!comment || !(await canAccessPost(comment.post, req.session.user.id))) return redirectBack(req, res, { ok: false });
  const alreadyLiked = comment.likes.some((id) => String(id) === String(req.session.user.id));
  if (alreadyLiked) comment.likes.pull(req.session.user.id);
  else comment.likes.addToSet(req.session.user.id);
  await comment.save();
  return redirectBack(req, res, { liked: !alreadyLiked, likes: comment.likes.length });
};

// The post author's own "special like" on a comment - like a creator heart on
// YouTube. Only the post's author can set it; it is separate from ordinary
// likes and notifies the comment's author.
exports.toggleAuthorHeart = async (req, res) => {
  const comment = await Comment.findById(req.params.id).populate('post', 'author status community');
  if (!comment || !comment.post || !(await canAccessPost(comment.post, req.session.user.id))) return redirectBack(req, res, { ok: false });
  if (String(comment.post.author) !== String(req.session.user.id)) return redirectBack(req, res, { ok: false, error: 'Only the post author can heart a comment.' });
  comment.heartedByAuthor = !comment.heartedByAuthor;
  await comment.save();
  if (comment.heartedByAuthor) await notify(comment.author, req.session.user.id, 'comment', 'hearted your comment.', comment.post._id, comment.post.community, req.session.user.name, `/posts/${comment.post._id}`);
  return redirectBack(req, res, { hearted: comment.heartedByAuthor });
};

exports.toggleCommentReaction = async (req, res) => {
  const comment = await Comment.findById(req.params.id).populate('post', 'author status community');
  if (!comment || !comment.post || !(await canAccessPost(comment.post, req.session.user.id))) return redirectBack(req, res, { ok: false });
  const result = toggleReaction(comment.reactions.map((entry) => entry.toObject()), req.body.emoji, req.session.user.id);
  if (!result) return redirectBack(req, res, { ok: false, error: 'Unsupported reaction.' });
  comment.set('reactions', result.reactions);
  await comment.save();
  if (result.reacted) await notify(comment.author, req.session.user.id, 'comment', `reacted ${req.body.emoji} to your comment.`, comment.post._id, comment.post.community, req.session.user.name, `/posts/${comment.post._id}`);
  return redirectBack(req, res, { ok: true, reactions: result.summary });
};

exports.toggleBookmark = async (req, res) => {
  const post = await Post.findById(req.params.id).select('author status community').lean();
  if (!(await canAccessPost(post, req.session.user.id))) return redirectBack(req, res, { ok: false });
  const user = await User.findById(req.session.user.id);
  if (!user) return redirectBack(req, res);
  const exists = user.bookmarks.some((id) => String(id) === req.params.id);
  if (exists) user.bookmarks.pull(req.params.id);
  else { user.bookmarks.addToSet(req.params.id); refreshPersonalization(req.session.user.id); }
  await user.save();
  redirectBack(req, res, { bookmarked: !exists });
};

// Copying the link or using the phone's share sheet does NOT count as a share:
// only sending a post to a person or group inside Crowdwide does (see
// shareController.send). This endpoint just hands back the public link.
exports.share = async (req, res) => {
  const existing = await Post.findById(req.params.id).select('author status community sharesCount');
  if (!(await canAccessPost(existing, req.session.user.id))) return redirectBack(req, res, { ok: false });
  if (req.get('X-Requested-With') !== 'XMLHttpRequest') return redirectBack(req, res);
  res.json({ url: `${process.env.APP_URL || 'http://localhost:3000'}/posts/${req.params.id}`, shares: existing.sharesCount || 0 });
};

exports.votePoll = async (req, res) => {
  const post = await Post.findById(req.params.id);
  const optionIndex = Number(req.body.optionIndex);
  if (!(await canAccessPost(post, req.session.user.id)) || !post.poll?.options?.[optionIndex]) return redirectBack(req, res, { ok: false, error: 'That poll is unavailable.' });
  const alreadyVoted = post.poll.options.some((option) => option.votes.some((id) => String(id) === String(req.session.user.id)));
  if (!alreadyVoted) post.poll.options[optionIndex].votes.addToSet(req.session.user.id);
  await post.save();
  return redirectBack(req, res, { voted: !alreadyVoted });
};

exports.toggleReaction = async (req, res) => {
  const reactionTypes = ['celebrate', 'insightful', 'support', 'funny'];
  const reaction = req.body.reaction;
  const post = await Post.findById(req.params.id);
  if (!(await canAccessPost(post, req.session.user.id)) || !reactionTypes.includes(reaction)) return redirectBack(req, res, { ok: false });
  const reactions = post.reactions?.toObject ? post.reactions.toObject() : { ...(post.reactions || {}) };
  reactionTypes.forEach((type) => {
    const users = Array.isArray(reactions[type]) ? reactions[type].map(String) : [];
    reactions[type] = users.filter((id) => id !== String(req.session.user.id));
  });
  const hadReaction = (post.reactions?.[reaction] || []).some((id) => String(id) === String(req.session.user.id));
  if (!hadReaction) { reactions[reaction].push(req.session.user.id); refreshPersonalization(req.session.user.id); }
  post.set('reactions', reactions);
  await post.save();
  const counts = Object.fromEntries(reactionTypes.map((type) => [type, (reactions[type] || []).length]));
  return redirectBack(req, res, { reaction: hadReaction ? null : reaction, counts });
};

exports.replyPost = async (req, res) => {
  const source = await Post.findById(req.params.id).select('author status community body').lean();
  const body = req.body.body?.trim();
  const wordCount = countWords(body);
  if (!(await canAccessPost(source, req.session.user.id)) || !body || wordCount > MAX_REPLY_POST_WORDS) {
    const error = `Reply posts are limited to ${MAX_REPLY_POST_WORDS} words.`;
    req.session.flash = { type: 'error', message: error };
    return redirectBack(req, res, { ok: false, error });
  }
  if (source.community) {
    const community = await Community.findById(source.community).select('members bannedWords owner');
    if (!community || (String(community.owner) !== String(req.session.user.id) && !community.members.some((id) => String(id) === String(req.session.user.id)))) {
      const error = 'Join the community before replying to this post.';
      req.session.flash = { type: 'error', message: error };
      return redirectBack(req, res, { ok: false, error });
    }
    const bodyLower = body.toLowerCase();
    if ((community.bannedWords || []).some((word) => word && bodyLower.includes(word))) {
      const error = 'That reply contains a word this community has blocked.';
      req.session.flash = { type: 'error', message: error };
      return redirectBack(req, res, { ok: false, error });
    }
  }
  const media = [];
  for (const [fileIndex, file] of (req.files || []).entries()) {
    const stored = await uploadBuffer(file.buffer, file.originalname, file.mimetype, { kind: file.mediaKind, owner: req.session.user.id });
    const item = { url: mediaUrl(stored), storageKey: stored.id, kind: file.mediaKind, ...mediaDetailsFor(req.body, fileIndex) };
    if (file.mediaKind === 'image') {
      const thumbnail = await createImageThumbnail(file.buffer);
      const thumbnailFile = await uploadBuffer(thumbnail, `${file.originalname}.thumb.webp`, 'image/webp', { kind: 'thumbnail', parent: stored.id, owner: req.session.user.id });
      item.thumbnailUrl = mediaUrl(thumbnailFile);
      const size = await getImageSize(file.buffer);
      if (size) Object.assign(item, size);
    }
    media.push(item);
  }
  const reply = await Post.create({ author: req.session.user.id, body, contentWarning: req.body.contentWarning?.trim().slice(0, 120) || '', media, type: 'post', community: source.community, replyTo: source._id, hashtags: extractHashtags(body), status: 'published' });
  refreshPersonalization(req.session.user.id);
  await notifyMentionedUsers(body, req.session.user.id, reply._id, reply.community);
  await notify(source.author, req.session.user.id, 'comment', 'replied to your post.', source._id, source.community, req.session.user.name);
  if (req.get('X-Requested-With') === 'XMLHttpRequest') return res.json({ ok: true, reply: { id: reply._id, body: reply.body } });
  return res.redirect(`/posts/${source._id}`);
};

exports.replyPostPage = async (req, res) => {
  const sourcePost = await Post.findById(req.params.id)
    .populate('author', 'name profilePicture')
    .populate('community', 'name slug')
    .lean();
  const accessPost = sourcePost && { ...sourcePost, community: sourcePost.community?._id || sourcePost.community };
  if (!(await canAccessPost(accessPost, req.session.user.id))) {
    req.session.flash = { type: 'error', message: 'That post is not available for a reply.' };
    return res.redirect('/dashboard');
  }
  res.render('pages/post-compose', {
    title: 'Reply with a post',
    pagePath: `/posts/${sourcePost._id}/reply`,
    noIndex: true,
    editorMode: 'reply',
    post: null,
    sourcePost,
    wordLimit: MAX_REPLY_POST_WORDS
  });
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
  const existing = await Post.findOne({ _id: req.params.id, $or: [{ status: { $nin: ['draft', 'scheduled'] } }, { author: viewerId || null }] }).select('author status community').lean();
  if (!(await canAccessPost(existing, viewerId))) return res.status(404).render('pages/not-found', { title: 'Post not found' });
  const post = await Post.findByIdAndUpdate(req.params.id, { $inc: { viewsCount: 1 } }, { new: true })
    .populate('author', 'name profilePicture')
    .populate('coAuthors', 'name profilePicture')
    .populate('community', 'name slug')
    .populate({ path: 'quotedPost', select: 'body author', populate: { path: 'author', select: 'name profilePicture' } })
    .populate({ path: 'replyTo', select: 'body author', populate: { path: 'author', select: 'name profilePicture' } })
    .lean();
  if (!post) return res.status(404).render('pages/not-found', { title: 'Post not found' });
  let blockedIds = [];
  let postModerationRole = null;
  if (viewerId) {
    const viewer = await User.findById(viewerId).select('bookmarks blockedUsers role').lean();
    post.liked = (post.likes || []).some((id) => String(id) === String(viewerId));
    post.bookmarked = (viewer?.bookmarks || []).some((id) => String(id) === String(post._id));
    blockedIds = (viewer?.blockedUsers || []).map(String);
    if (['admin', 'moderator'].includes(viewer?.role)
      && !(viewer.role === 'moderator' && String(post.author?._id || post.author) === String(viewerId))) {
      postModerationRole = viewer.role;
    }
    // Log the open for feed personalization (what this person reads, not
    // just what they like/comment on) - skip their own posts, those don't
    // tell us anything about outside interests. Most-recent-first, capped
    // at 60 so the array never grows unbounded. Fire-and-forget: a slow or
    // failed write here should never hold up or break the page render.
    if (String(post.author?._id || post.author) !== String(viewerId)) {
      User.updateOne({ _id: viewerId }, { $push: { recentViews: { $each: [{ post: post._id, viewedAt: new Date() }], $position: 0, $slice: 60 } } }).catch(() => {});
    }
  }
  const comments = (await Comment.find({ post: post._id }).sort({ createdAt: 1 }).populate('author', 'name profilePicture').lean())
    .filter((comment) => !blockedIds.includes(String(comment.author?._id)));
  const commentTree = buildCommentTree(comments);
  res.render('pages/post-detail', { title: `${post.author?.name || 'Crowdwide'} post`, pagePath: `/posts/${post._id}`, noIndex: false, post, comments, commentTree, postModerationRole });
};

exports.commentThread = async (req, res) => {
  const post = await Post.findById(req.params.id).select('author status community').lean();
  if (!(await canAccessPost(post, req.session.user?.id))) return res.status(404).json({ comments: [] });
  const comments = await Comment.find({ post: req.params.id }).sort({ createdAt: 1 }).populate('author', 'name profilePicture').lean();
  res.json({ comments });
};

exports.notifications = async (req, res) => {
  const viewer = await User.findById(req.session.user.id).select('blockedUsers mutedUsers').lean();
  await Promise.all([
    Notification.updateMany({ recipient: req.session.user.id, readAt: null }, { readAt: new Date() }),
    User.updateOne({ _id: req.session.user.id }, { $unset: { unreadSummarySentAt: 1 } })
  ]);
  const [notificationsRaw, unread] = await Promise.all([
    Notification.find({ recipient: req.session.user.id }).sort({ createdAt: -1 }).limit(50).populate('actor', 'name profilePicture').lean(),
    Notification.countDocuments({ recipient: req.session.user.id, readAt: null })
  ]);
  const hiddenIds = [...(viewer?.blockedUsers || []), ...(viewer?.mutedUsers || [])].map(String);
  const visibleNotifications = notificationsRaw.filter((notification) => !notification.actor || !hiddenIds.includes(String(notification.actor._id)));
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
  try {
    const userId = req.session.user.id;
    const [messages, viewer] = await Promise.all([
      Message.find({ $or: [{ sender: userId }, { recipient: userId }] })
        .sort({ createdAt: -1 }).limit(300)
        .populate('sender', 'name profilePicture').populate('recipient', 'name profilePicture').lean(),
      User.findById(userId).select('acceptedDmFrom declinedDmFrom').lean()
    ]);
    const accepted = new Set((viewer?.acceptedDmFrom || []).map(String));
    const declined = new Set((viewer?.declinedDmFrom || []).map(String));
    const conversations = new Map();
    messages.forEach((message) => {
      const senderId = String(message.sender._id);
      const other = senderId === String(userId) ? message.recipient : message.sender;
      const key = String(other._id);
      if (!conversations.has(key)) conversations.set(key, { person: other, latest: message, preview: previewText(message), unread: 0, viewerHasSent: false, otherHasSent: false });
      const entry = conversations.get(key);
      if (senderId === String(userId)) entry.viewerHasSent = true; else entry.otherHasSent = true;
      if (String(message.recipient._id) === String(userId) && !message.readAt) entry.unread += 1;
    });
    const all = Array.from(conversations.values());
    // A thread is a pending request only while the OTHER person started it,
    // the viewer hasn't replied, and the viewer hasn't already decided on it.
    const requests = all.filter((c) => c.otherHasSent && !c.viewerHasSent && !accepted.has(String(c.person._id)) && !declined.has(String(c.person._id)));
    const requestIds = new Set(requests.map((c) => String(c.person._id)));
    const conversationList = all.filter((c) => !requestIds.has(String(c.person._id)) && !declined.has(String(c.person._id)));
    res.render('pages/messages', { title: 'Messages', pagePath: '/messages', noIndex: true, conversations: conversationList, requestCount: requests.length });
  } catch (error) {
    logger.error('Loading messages failed', error);
    res.status(500).render('pages/not-found', { title: 'Crowdwide is having trouble' });
  }
};

exports.messageRequests = async (req, res) => {
  try {
    const userId = req.session.user.id;
    const [messages, viewer] = await Promise.all([
      Message.find({ $or: [{ sender: userId }, { recipient: userId }] })
        .sort({ createdAt: -1 }).limit(300)
        .populate('sender', 'name profilePicture').populate('recipient', 'name profilePicture').lean(),
      User.findById(userId).select('acceptedDmFrom declinedDmFrom blockedUsers').lean()
    ]);
    const accepted = new Set((viewer?.acceptedDmFrom || []).map(String));
    const declined = new Set((viewer?.declinedDmFrom || []).map(String));
    const blocked = new Set((viewer?.blockedUsers || []).map(String));
    const conversations = new Map();
    messages.forEach((message) => {
      const senderId = String(message.sender._id);
      const other = senderId === String(userId) ? message.recipient : message.sender;
      const key = String(other._id);
      if (!conversations.has(key)) conversations.set(key, { person: other, latest: message, preview: previewText(message), viewerHasSent: false, otherHasSent: false });
      const entry = conversations.get(key);
      if (senderId === String(userId)) entry.viewerHasSent = true; else entry.otherHasSent = true;
    });
    const requests = Array.from(conversations.values())
      .filter((c) => c.otherHasSent && !c.viewerHasSent && !accepted.has(String(c.person._id)) && !declined.has(String(c.person._id)) && !blocked.has(String(c.person._id)));
    res.render('pages/message-requests', { title: 'Message requests', pagePath: '/messages/requests', noIndex: true, requests });
  } catch (error) {
    logger.error('Loading message requests failed', error);
    res.status(500).render('pages/not-found', { title: 'Crowdwide is having trouble' });
  }
};

exports.readNotifications = async (req, res) => {
  await Notification.updateMany({ recipient: req.session.user.id, readAt: null }, { readAt: new Date() });
  await User.updateOne({ _id: req.session.user.id }, { $unset: { unreadSummarySentAt: 1 } });
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

exports.toggleMute = async (req, res) => {
  const targetId = req.params.id;
  if (targetId === String(req.session.user.id)) return redirectBack(req, res, { ok: false });
  const user = await User.findById(req.session.user.id);
  const target = await User.exists({ _id: targetId });
  if (!user || !target) return redirectBack(req, res, { ok: false });
  const alreadyMuted = (user.mutedUsers || []).some((id) => String(id) === targetId);
  if (alreadyMuted) user.mutedUsers.pull(targetId);
  else user.mutedUsers.addToSet(targetId);
  await user.save();
  redirectBack(req, res, { muted: !alreadyMuted });
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
    await notify(target._id, user._id, 'follow', 'started following you.', undefined, undefined, user.name);
  }
  await user.save();
  refreshPersonalization(user._id); // follow changes what "For you" should show
  const followersCount = await User.countDocuments({ following: targetId });
  redirectBack(req, res, { following: !alreadyFollowing, followersCount });
};
