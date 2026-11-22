const mongoose = require('mongoose');
const AiAction = require('../models/AiAction');
const AiConversation = require('../models/AiConversation');
const AiMemory = require('../models/AiMemory');
const AiMessage = require('../models/AiMessage');
const AiPreference = require('../models/AiPreference');
const Post = require('../models/Post');
const Comment = require('../models/Comment');
const Message = require('../models/Message');
const GroupConversation = require('../models/GroupConversation');
const GroupMessage = require('../models/GroupMessage');
const Notification = require('../models/Notification');
const User = require('../models/User');
const { canAccessPost } = require('./interactionController');
const logger = require('../services/logger');
const { checkPostingRestriction } = require('../utils/postingRestriction');
const {
  buildFallbackResponse,
  executeCrowdwideTools,
  getMyChatContext,
  parseActionRequest,
  titleFromPrompt
} = require('../services/crowdwideAi');

const isValidId = (id) => mongoose.isValidObjectId(id);
const ownerId = (req) => req.session.user.id;

function escapedRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function publicMessage(message, action = null) {
  return {
    id: String(message._id),
    role: message.role,
    replyTo: message.replyTo ? String(message.replyTo) : null,
    content: message.content,
    sources: message.sources || [],
    feedback: message.feedback || null,
    createdAt: message.createdAt,
    ...(action ? { action } : {})
  };
}

function sendError(res, error, message) {
  if (error.status && error.status < 500) return res.status(error.status).json({ error: error.message });
  logger.error(message, { error, route: 'crowdwide-ai' });
  return res.status(500).json({ error: 'Crowdwide AI is temporarily unavailable.' });
}

async function getPreferences(userId) {
  return AiPreference.findOneAndUpdate(
    { user: userId },
    { $setOnInsert: { user: userId } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
}

async function addAssistant(conversationId, userId, replyTo, content, sources = [], actionId = null) {
  const message = await AiMessage.create({
    user: userId,
    conversation: conversationId,
    role: 'assistant',
    replyTo,
    content,
    sources,
    actionId
  });
  await AiConversation.updateOne({ _id: conversationId, user: userId }, { lastMessageAt: new Date() });
  return message;
}

function publicAction(action, targetUrl = '') {
  return {
    id: String(action._id),
    kind: action.kind,
    postId: action.post ? String(action.post) : null,
    commentId: action.comment ? String(action.comment) : null,
    recipientId: action.recipient ? String(action.recipient) : null,
    groupId: action.group ? String(action.group) : null,
    targetLabel: action.targetLabel,
    targetUrl,
    postPreview: action.postPreview,
    content: action.content,
    status: action.status
  };
}

async function resolveActionRequest(actionRequest, userId) {
  const resolved = { ...actionRequest, context: [] };
  if (actionRequest.kind === 'create_post') return resolved;

  if (['edit_post', 'delete_post', 'create_comment'].includes(actionRequest.kind)) {
    let postId = actionRequest.postId;
    if (postId === 'latest') {
      const latest = await Post.findOne({
        author: userId,
        status: 'published'
      }).sort({ createdAt: -1 }).select('_id').lean();
      postId = latest ? String(latest._id) : '';
    }
    if (!isValidId(postId)) return { error: 'I could not identify a valid post for that request.' };
    const post = await Post.findById(postId).select('_id author body status community revision').lean();
    if (!post) return { error: 'That post is no longer available.' };
    if (['edit_post', 'delete_post'].includes(actionRequest.kind) && String(post.author) !== String(userId)) {
      return { error: 'I can only edit or delete posts that belong to your account.' };
    }
    if (actionRequest.kind === 'create_comment' && !await canAccessPost(post, userId)) {
      return { error: 'That post is not available to your account.' };
    }
    resolved.postId = String(post._id);
    resolved.post = post;
    resolved.postPreview = String(post.body || '').slice(0, 180);
    resolved.targetLabel = `Post: ${resolved.postPreview || 'Untitled post'}`;
    resolved.targetUrl = `/posts/${post._id}`;
    resolved.context.push({
      type: 'post',
      title: resolved.targetLabel,
      text: String(post.body || '').slice(0, 1200),
      url: resolved.targetUrl
    });
  }

  if (actionRequest.kind === 'reply_comment') {
    let commentId = actionRequest.commentId;
    if (commentId === 'latest_on_my_post') {
      const latestPost = await Post.findOne({ author: userId, status: 'published' })
        .sort({ createdAt: -1 }).select('_id').lean();
      const latestComment = latestPost && await Comment.findOne({ post: latestPost._id, author: { $ne: userId } })
        .sort({ createdAt: -1 }).select('_id').lean();
      commentId = latestComment ? String(latestComment._id) : '';
    } else if (commentId === 'latest_mention') {
      const [viewer, notification] = await Promise.all([
        User.findById(userId).select('username').lean(),
        Notification.findOne({ recipient: userId, type: { $in: ['mention', 'reply', 'post_reply'] } })
          .sort({ createdAt: -1 }).select('post url').lean()
      ]);
      const linkedCommentId = notification?.url?.match(/#comment-([a-f\d]{24})/i)?.[1];
      let mentionedComment = linkedCommentId
        ? await Comment.findById(linkedCommentId).select('_id post').lean()
        : null;
      if (!mentionedComment && notification?.post && viewer?.username) {
        mentionedComment = await Comment.findOne({
          post: notification.post,
          author: { $ne: userId },
          body: new RegExp(`@${escapedRegex(viewer.username)}\\b`, 'i')
        }).sort({ createdAt: -1 }).select('_id post').lean();
      }
      if (mentionedComment) {
        commentId = String(mentionedComment._id);
      } else if (notification?.post && viewer?.username) {
        const mentionedPost = await Post.findOne({
          _id: notification.post,
          body: new RegExp(`@${escapedRegex(viewer.username)}\\b`, 'i')
        }).select('_id author body status community revision').lean();
        if (mentionedPost && await canAccessPost(mentionedPost, userId)) {
          resolved.kind = 'create_comment';
          resolved.post = mentionedPost;
          resolved.postId = String(mentionedPost._id);
          resolved.postPreview = String(mentionedPost.body || '').slice(0, 180);
          resolved.targetLabel = `Comment on post: ${resolved.postPreview}`;
          resolved.targetUrl = `/posts/${mentionedPost._id}`;
          resolved.context.push({
            type: 'post',
            title: 'Post that mentioned you',
            text: String(mentionedPost.body || '').slice(0, 1200),
            url: resolved.targetUrl
          });
          return resolved;
        }
        return { error: 'I could not find a recent post mention that is available to your account.' };
      } else {
        commentId = '';
      }
    }
    if (!isValidId(commentId)) return { error: 'I could not find a recent comment to reply to. Include its comment ID or open the discussion first.' };
    const comment = await Comment.findById(commentId).select('_id post author body').lean();
    if (!comment) return { error: 'That comment is no longer available.' };
    const post = await Post.findById(comment.post).select('_id author body status community').lean();
    if (!post || !await canAccessPost(post, userId)) return { error: 'That discussion is not available to your account.' };
    resolved.commentId = String(comment._id);
    resolved.postId = String(post._id);
    resolved.comment = comment;
    resolved.post = post;
    resolved.postPreview = String(post.body || '').slice(0, 180);
    resolved.targetLabel = `Reply to comment: ${String(comment.body || '').slice(0, 100)}`;
    resolved.targetUrl = `/posts/${post._id}#comment-${comment._id}`;
    resolved.context.push(
      { type: 'post', title: 'Post being discussed', text: String(post.body || '').slice(0, 900), url: `/posts/${post._id}` },
      { type: 'comment', title: 'Comment to reply to', text: String(comment.body || '').slice(0, 900), url: resolved.targetUrl }
    );
  }

  if (actionRequest.kind === 'send_message') {
    if (actionRequest.groupId) {
      let groupId = actionRequest.groupId;
      if (groupId === 'latest') {
        const groupIds = await GroupConversation.find({ members: userId }).distinct('_id');
        const latest = await GroupMessage.findOne({ group: { $in: groupIds }, kind: 'message' })
          .sort({ createdAt: -1 }).select('group').lean();
        groupId = latest ? String(latest.group) : '';
      }
      if (!isValidId(groupId)) return { error: 'I could not identify an available group conversation.' };
      const group = await GroupConversation.findOne({ _id: groupId, members: userId }).select('_id name').lean();
      if (!group) return { error: 'That group is no longer available to your account.' };
      resolved.group = group;
      resolved.targetLabel = `Group message in ${group.name}`;
      resolved.targetUrl = `/groups/${group._id}`;
      resolved.context = (await getMyChatContext(`messages in group ${group._id}`, userId, { includeMessages: true }))
        .map((source) => ({ type: source.type, title: source.title, text: source.excerpt, url: source.url }));
      resolved.content = actionRequest.content;
      return resolved;
    }
    let recipientId = actionRequest.recipient;
    if (recipientId === 'latest') {
      const latest = await Message.findOne({ $or: [{ sender: userId }, { recipient: userId }] })
        .sort({ createdAt: -1 }).select('sender recipient').lean();
      if (!latest) return { error: 'There is no existing direct conversation to reply to.' };
      recipientId = String(latest.sender) === String(userId) ? String(latest.recipient) : String(latest.sender);
    } else if (!isValidId(recipientId)) {
      const byUsername = await User.findOne({ username: String(recipientId).toLowerCase(), isVerified: true }).select('_id').lean();
      recipientId = byUsername ? String(byUsername._id) : '';
    }
    if (!isValidId(recipientId) || String(recipientId) === String(userId)) return { error: 'I could not identify a valid conversation partner.' };
    const [recipient, viewer] = await Promise.all([
      User.findById(recipientId).select('_id name username isVerified blockedUsers').lean(),
      User.findById(userId).select('blockedUsers').lean()
    ]);
    if (!recipient?.isVerified) return { error: 'That account is unavailable for messaging.' };
    if ((viewer?.blockedUsers || []).some((id) => String(id) === recipientId) ||
        (recipient.blockedUsers || []).some((id) => String(id) === String(userId))) {
      return { error: 'Messaging is unavailable for that account.' };
    }
    resolved.recipientId = recipientId;
    resolved.targetLabel = `Direct message to ${recipient.name || recipient.username}`;
    resolved.targetUrl = `/messages/${recipientId}`;
    resolved.context = await getMyChatContext(`messages with ${recipient.username}`, userId, { includeMessages: true });
    resolved.context = resolved.context.map((source) => ({
      type: source.type,
      title: source.title,
      text: source.excerpt,
      url: source.url
    }));
  }

  return resolved;
}

async function createActionProposal(actionRequest, { userId, conversationId, sourceMessageId }) {
  if (sourceMessageId) {
    const existing = await AiAction.findOne({ sourceMessage: sourceMessageId, user: userId }).lean();
    if (existing) return { error: 'An action proposal already exists for this request.' };
  }
  const { kind } = actionRequest;
  const maxLength = ['create_comment', 'reply_comment', 'send_message'].includes(kind) ? 2000 : 4000;
  if (kind !== 'delete_post' && (!actionRequest.content || actionRequest.content.length > maxLength)) {
    return { error: `Draft content must contain 1–${maxLength.toLocaleString()} characters.` };
  }
  if (kind === 'create_post') {
    const restriction = await checkPostingRestriction(userId);
    if (restriction) return { error: restriction };
  }
  if (['edit_post', 'delete_post'].includes(kind) && (!actionRequest.post || String(actionRequest.post.author) !== String(userId))) {
    return { error: 'I can only edit or delete posts that belong to your account.' };
  }
  if (['create_comment', 'reply_comment'].includes(kind)) {
    if (!actionRequest.post || !await canAccessPost(actionRequest.post, userId)) return { error: 'That discussion is not available to your account.' };
    if (kind === 'reply_comment' && (!actionRequest.comment || String(actionRequest.comment.post) !== String(actionRequest.post._id))) {
      return { error: 'That comment is no longer part of this discussion.' };
    }
  }
  if (kind === 'send_message' && !actionRequest.recipientId && !actionRequest.group) return { error: 'Choose a conversation partner before sending a message.' };
  const action = await AiAction.create({
    user: userId,
    conversation: conversationId,
    sourceMessage: sourceMessageId || null,
    kind,
    post: actionRequest.post?._id || null,
    comment: actionRequest.comment?._id || null,
    recipient: actionRequest.recipientId || null,
    group: actionRequest.group?._id || null,
    postPreview: actionRequest.postPreview || (actionRequest.post?.body ? actionRequest.post.body.slice(0, 180) : ''),
    targetLabel: actionRequest.targetLabel || '',
    content: actionRequest.content || '',
    revision: actionRequest.post ? actionRequest.post.revision || 0 : null,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000)
  });
  return {
    action,
    preview: {
      id: String(action._id),
      kind,
      postId: action.post ? String(action.post) : null,
      commentId: action.comment ? String(action.comment) : null,
      recipientId: action.recipient ? String(action.recipient) : null,
      groupId: action.group ? String(action.group) : null,
      targetLabel: action.targetLabel,
      targetUrl: actionRequest.targetUrl || (action.post ? `/posts/${action.post}${action.comment ? `#comment-${action.comment}` : ''}` : action.group ? `/groups/${action.group._id}` : action.recipient ? `/messages/${action.recipient}` : ''),
      content: action.content,
      status: action.status,
      postPreview: action.postPreview
    }
  };
}

async function resumeExistingTurn(userMessage, { userId, conversation }) {
  const assistant = await AiMessage.findOne({
    user: userId,
    conversation: conversation._id,
    role: 'assistant',
    replyTo: userMessage._id
  }).sort({ createdAt: -1 }).lean();
  if (assistant) {
    const action = assistant.actionId
      ? await AiAction.findOne({ _id: assistant.actionId, user: userId }).lean()
      : null;
    return {
      userMessage: publicMessage(userMessage),
      assistantMessage: publicMessage(assistant, action ? publicAction(action,
        action.post ? `/posts/${action.post}${action.comment ? `#comment-${action.comment}` : ''}` : action.group ? `/groups/${action.group}` : action.recipient ? `/messages/${action.recipient}` : ''
      ) : null),
      localInference: false
    };
  }
  const preferences = await getPreferences(userId);
  const memories = preferences.localInference
    ? await AiMemory.find({ user: userId }).sort({ updatedAt: -1 }).limit(10).select('kind text updatedAt').lean()
    : [];
  if (userMessage.actionDraft) {
    return {
      userMessage: publicMessage(userMessage),
      turnId: String(userMessage._id),
      context: userMessage.context || [],
      sources: userMessage.sources || [],
      memories,
      actionDraft: userMessage.actionDraft,
      localInference: true
    };
  }
  if (preferences.localInference) {
    return {
      userMessage: publicMessage(userMessage),
      turnId: String(userMessage._id),
      context: userMessage.context || [],
      sources: userMessage.sources || [],
      memories,
      localInference: true
    };
  }
  const result = await executeCrowdwideTools({ query: userMessage.content, userId });
  const fallbackAssistant = await addAssistant(
    conversation._id,
    userId,
    userMessage._id,
    buildFallbackResponse(result),
    result.sources
  );
  return { userMessage: publicMessage(userMessage), assistantMessage: publicMessage(fallbackAssistant), localInference: false };
}

async function prepareTurn({ userId, conversation, content, clientRequestId }) {
  if (clientRequestId) {
    const existing = await AiMessage.findOne({ user: userId, clientRequestId });
    if (existing) {
      if (String(existing.conversation) !== String(conversation._id) || existing.content !== content) {
        const conflict = new Error('That request identifier was already used for a different message.');
        conflict.status = 409;
        throw conflict;
      }
      return resumeExistingTurn(existing, { userId, conversation });
    }
  }
  const preferences = await getPreferences(userId);
  const memories = preferences.localInference
    ? await AiMemory.find({ user: userId }).sort({ updatedAt: -1 }).limit(10).select('kind text updatedAt').lean()
    : [];
  const actionRequest = parseActionRequest(content);
  const resolvedAction = actionRequest ? await resolveActionRequest(actionRequest, userId) : null;
  const actionDraft = resolvedAction && !resolvedAction.error && actionRequest.draftPrompt
    ? {
      kind: resolvedAction.kind,
      postId: resolvedAction.postId || null,
      commentId: resolvedAction.commentId || null,
      recipientId: resolvedAction.recipientId || null,
      groupId: resolvedAction.group?._id ? String(resolvedAction.group._id) : null,
      targetLabel: resolvedAction.targetLabel || 'New post',
      targetUrl: resolvedAction.targetUrl || '',
      postPreview: resolvedAction.postPreview || '',
      revision: resolvedAction.post?.revision ?? null,
      prompt: actionRequest.draftPrompt
    }
    : null;
  const result = actionRequest
    ? { tool: 'action', action: resolvedAction, sources: [], context: resolvedAction?.context || [], summary: '' }
    : await executeCrowdwideTools({ query: content, userId });
  let userMessage;
  try {
    userMessage = await AiMessage.create({
      user: userId,
      conversation: conversation._id,
      role: 'user',
      content,
      clientRequestId: clientRequestId || undefined,
      sources: result.sources,
      context: result.context,
      actionDraft
    });
  } catch (error) {
    if (error?.code === 11000 && clientRequestId) {
      const existing = await AiMessage.findOne({ user: userId, clientRequestId });
      if (existing) {
        if (String(existing.conversation) !== String(conversation._id) || existing.content !== content) throw error;
        return resumeExistingTurn(existing, { userId, conversation });
      }
    }
    throw error;
  }
  const update = { lastMessageAt: new Date() };
  if (conversation.title === 'New conversation') update.title = titleFromPrompt(content);
  await AiConversation.updateOne({ _id: conversation._id, user: userId }, { $set: update });

  if (actionRequest) {
    if (resolvedAction?.error) {
      const assistant = await addAssistant(conversation._id, userId, userMessage._id, `I couldn't prepare that action: ${resolvedAction.error}`);
      return { userMessage: publicMessage(userMessage), assistantMessage: publicMessage(assistant), localInference: false };
    }
    if (actionDraft && preferences.localInference) {
      return {
        userMessage: publicMessage(userMessage),
        turnId: String(userMessage._id),
        context: result.context,
        sources: [],
        memories,
        actionDraft,
        localInference: true
      };
    }
    if (actionDraft && !preferences.localInference) {
      const assistant = await addAssistant(conversation._id, userId, userMessage._id, 'Turn on on-device AI to generate a draft, or include the exact text after a colon.');
      return { userMessage: publicMessage(userMessage), assistantMessage: publicMessage(assistant), localInference: false };
    }
    const proposal = await createActionProposal(resolvedAction, {
      userId,
      conversationId: conversation._id,
      sourceMessageId: userMessage._id
    });
    const text = proposal.error
      ? `I couldn't prepare that action: ${proposal.error}`
      : `I can ${actionRequest.kind === 'create_post' ? 'publish this post' : actionRequest.kind === 'edit_post' ? 'update your post' : actionRequest.kind === 'delete_post' ? 'delete your post' : actionRequest.kind === 'create_comment' ? 'publish this comment' : actionRequest.kind === 'reply_comment' ? 'publish this reply' : 'send this message'}. Nothing changes until you confirm below.`;
    const assistant = await addAssistant(conversation._id, userId, userMessage._id, text, [], proposal.action?._id || null);
    return {
      userMessage: publicMessage(userMessage),
      assistantMessage: publicMessage(assistant, proposal.preview || null),
      localInference: false
    };
  }

  if (preferences.localInference) {
    return {
      userMessage: publicMessage(userMessage),
      turnId: String(userMessage._id),
      context: result.context,
      sources: result.sources,
      memories,
      localInference: true
    };
  }

  const assistant = await addAssistant(
    conversation._id,
    userId,
    userMessage._id,
    buildFallbackResponse(result),
    result.sources
  );
  return {
    userMessage: publicMessage(userMessage),
    assistantMessage: publicMessage(assistant),
    localInference: false
  };
}

exports.page = (req, res) => res.render('pages/crowdwide-ai', {
  title: 'Crowdwide AI',
  pagePath: '/crowdwide-ai',
  noIndex: true,
  aiPage: true,
  bodyClass: 'crowdwide-ai-page'
});

exports.listConversations = async (req, res) => {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    const filter = { user: ownerId(req) };
    if (query) {
      const regex = new RegExp(escapedRegex(query), 'i');
      const messageRows = await AiMessage.find({ user: ownerId(req), $text: { $search: query } })
        .limit(100)
        .select('conversation')
        .lean();
      const matchingMessages = [...new Set(messageRows.map((message) => String(message.conversation)))].slice(0, 50);
      filter.$or = [{ title: regex }, { _id: { $in: matchingMessages } }];
    }
    const conversations = await AiConversation.find(filter)
      .sort({ lastMessageAt: -1 })
      .limit(50)
      .select('title lastMessageAt createdAt updatedAt')
      .lean();
    return res.json({ conversations: conversations.map((item) => ({
      id: String(item._id),
      title: item.title,
      lastMessageAt: item.lastMessageAt
    })) });
  } catch (error) {
    return sendError(res, error, 'Could not list Crowdwide AI conversations');
  }
};

exports.createConversation = async (req, res) => {
  try {
    const conversation = await AiConversation.create({ user: ownerId(req) });
    return res.status(201).json({ conversation: { id: String(conversation._id), title: conversation.title } });
  } catch (error) {
    return sendError(res, error, 'Could not create Crowdwide AI conversation');
  }
};

exports.renameConversation = async (req, res) => {
  try {
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (!title || title.length > 80) return res.status(400).json({ error: 'Conversation names must be 1–80 characters.' });
    const conversation = await AiConversation.findOneAndUpdate(
      { _id: req.params.id, user: ownerId(req) },
      { title },
      { new: true, runValidators: true }
    ).select('title');
    if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
    return res.json({ id: String(conversation._id), title: conversation.title });
  } catch (error) {
    return sendError(res, error, 'Could not rename Crowdwide AI conversation');
  }
};

exports.deleteConversation = async (req, res) => {
  try {
    const conversation = await AiConversation.findOneAndDelete({ _id: req.params.id, user: ownerId(req) });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
    await Promise.all([
      AiMessage.deleteMany({ conversation: conversation._id, user: ownerId(req) }),
      AiAction.deleteMany({ conversation: conversation._id, user: ownerId(req) })
    ]);
    return res.json({ ok: true });
  } catch (error) {
    return sendError(res, error, 'Could not delete Crowdwide AI conversation');
  }
};

exports.listMessages = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Conversation not found.' });
    const conversation = await AiConversation.exists({ _id: req.params.id, user: ownerId(req) });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
    const messages = await AiMessage.find({ conversation: req.params.id, user: ownerId(req) })
      .sort({ createdAt: -1 })
      .limit(100)
      .select('-context')
      .lean();
    messages.reverse();
    const actionIds = messages.filter((message) => message.actionId).map((message) => message.actionId);
    const actions = actionIds.length
      ? await AiAction.find({ _id: { $in: actionIds }, user: ownerId(req) }).select('kind post comment recipient group targetLabel postPreview content status').lean()
      : [];
    const actionsById = new Map(actions.map((action) => [String(action._id), action]));
    return res.json({ messages: messages.map((message) => {
      const action = message.actionId && actionsById.get(String(message.actionId));
      return publicMessage(message, action ? publicAction(action,
        action.post ? `/posts/${action.post}${action.comment ? `#comment-${action.comment}` : ''}` : action.group ? `/groups/${action.group}` : action.recipient ? `/messages/${action.recipient}` : ''
      ) : null);
    }) });
  } catch (error) {
    return sendError(res, error, 'Could not load Crowdwide AI messages');
  }
};

exports.sendMessage = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Conversation not found.' });
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!content || content.length > 4000) return res.status(400).json({ error: 'Messages must be 1–4,000 characters.' });
    const rawRequestId = typeof req.body?.clientRequestId === 'string' ? req.body.clientRequestId.trim() : '';
    const clientRequestId = /^[A-Za-z0-9_-]{8,64}$/.test(rawRequestId) ? rawRequestId : '';
    const conversation = await AiConversation.findOne({ _id: req.params.id, user: ownerId(req) });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
    return res.json(await prepareTurn({ userId: ownerId(req), conversation, content, clientRequestId }));
  } catch (error) {
    return sendError(res, error, 'Crowdwide AI could not process a message');
  }
};

exports.prepareActionDraft = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Message not found.' });
    const userId = ownerId(req);
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!content || content.length > 4000) return res.status(400).json({ error: 'Drafts must contain 1–4,000 characters.' });
    const userMessage = await AiMessage.findOne({
      _id: req.params.id,
      user: userId,
      role: 'user'
    }).select('conversation content actionDraft');
    if (!userMessage?.actionDraft) return res.status(404).json({ error: 'Draft action not found.' });
    const conversation = await AiConversation.exists({ _id: userMessage.conversation, user: userId });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
    const existing = await AiAction.findOne({ sourceMessage: userMessage._id, user: userId }).lean();
    if (existing) {
      const assistant = await AiMessage.findOne({ replyTo: userMessage._id, role: 'assistant', user: userId })
        .sort({ createdAt: -1 }).lean();
      if (!assistant) return res.status(409).json({ error: 'This action proposal is already being prepared.' });
      return res.json({
        assistantMessage: publicMessage(assistant, {
          id: String(existing._id),
          kind: existing.kind,
          postId: existing.post ? String(existing.post) : null,
          commentId: existing.comment ? String(existing.comment) : null,
          recipientId: existing.recipient ? String(existing.recipient) : null,
          groupId: existing.group ? String(existing.group) : null,
          targetLabel: existing.targetLabel,
          targetUrl: userMessage.actionDraft.targetUrl || '',
          postPreview: existing.postPreview,
          content: existing.content,
          status: existing.status
        })
      });
    }

    const storedDraft = userMessage.actionDraft;
    const actionRequest = {
      kind: storedDraft.kind,
      postId: storedDraft.postId,
      commentId: storedDraft.commentId,
      recipient: storedDraft.recipientId,
      groupId: storedDraft.groupId,
      content
    };
    if (!['create_post', 'edit_post', 'create_comment', 'reply_comment', 'send_message'].includes(actionRequest.kind)) {
      return res.status(400).json({ error: 'Unsupported draft action.' });
    }
    const resolvedAction = await resolveActionRequest(actionRequest, userId);
    if (resolvedAction.error) return res.status(409).json({ error: resolvedAction.error });
    if (storedDraft.revision !== null && (resolvedAction.post?.revision || 0) !== storedDraft.revision) {
      return res.status(409).json({ error: 'The post changed while I was drafting. Please ask me to prepare a fresh draft.' });
    }
    resolvedAction.targetLabel = storedDraft.targetLabel || resolvedAction.targetLabel;
    resolvedAction.targetUrl = storedDraft.targetUrl || resolvedAction.targetUrl;
    const proposal = await createActionProposal(resolvedAction, {
      userId,
      conversationId: userMessage.conversation,
      sourceMessageId: userMessage._id
    });
    if (proposal.error) return res.status(409).json({ error: proposal.error });
    const assistant = await addAssistant(
      userMessage.conversation,
      userId,
      userMessage._id,
      `Review this ${actionRequest.kind.replace('_', ' ')} draft. Nothing changes until you confirm below.`,
      [],
      proposal.action._id
    );
    return res.status(201).json({ assistantMessage: publicMessage(assistant, proposal.preview) });
  } catch (error) {
    return sendError(res, error, 'Could not prepare Crowdwide AI action draft');
  }
};

exports.regenerate = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Message not found.' });
    const userMessage = await AiMessage.findOne({
      _id: req.params.id,
      user: ownerId(req),
      role: 'user'
    }).select('conversation content');
    if (!userMessage) return res.status(404).json({ error: 'Message not found.' });
    if (parseActionRequest(userMessage.content)) return res.status(400).json({ error: 'Action proposals cannot be regenerated.' });
    const conversation = await AiConversation.findOne({ _id: userMessage.conversation, user: ownerId(req) });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
    const [preferences, result] = await Promise.all([
      getPreferences(ownerId(req)),
      executeCrowdwideTools({ query: userMessage.content, userId: ownerId(req) })
    ]);
    const memories = preferences.localInference
      ? await AiMemory.find({ user: ownerId(req) }).sort({ updatedAt: -1 }).limit(10).select('kind text updatedAt').lean()
      : [];
    await AiMessage.updateOne({ _id: userMessage._id, user: ownerId(req) }, { sources: result.sources, context: result.context });
    if (preferences.localInference) {
      return res.json({
        turnId: String(userMessage._id),
        context: result.context,
        sources: result.sources,
        memories,
        localInference: true
      });
    }
    await AiMessage.deleteMany({
      user: ownerId(req),
      conversation: conversation._id,
      role: 'assistant',
      replyTo: userMessage._id
    });
    const assistant = await addAssistant(
      conversation._id,
      ownerId(req),
      userMessage._id,
      buildFallbackResponse(result),
      result.sources
    );
    return res.json({ assistantMessage: publicMessage(assistant), localInference: false });
  } catch (error) {
    return sendError(res, error, 'Could not regenerate Crowdwide AI response');
  }
};

exports.fallbackTurn = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Message not found.' });
    const userMessage = await AiMessage.findOne({ _id: req.params.id, user: ownerId(req), role: 'user' })
      .select('conversation content');
    if (!userMessage) return res.status(404).json({ error: 'Message not found.' });
    if (parseActionRequest(userMessage.content)) return res.status(400).json({ error: 'Action proposals cannot be regenerated.' });
    const conversation = await AiConversation.exists({ _id: userMessage.conversation, user: ownerId(req) });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
    const result = await executeCrowdwideTools({ query: userMessage.content, userId: ownerId(req) });
    await AiMessage.updateOne({ _id: userMessage._id, user: ownerId(req) }, { sources: result.sources, context: result.context });
    await AiMessage.deleteMany({
      user: ownerId(req),
      conversation: userMessage.conversation,
      role: 'assistant',
      replyTo: userMessage._id
    });
    const assistant = await addAssistant(
      userMessage.conversation,
      ownerId(req),
      userMessage._id,
      buildFallbackResponse(result),
      result.sources
    );
    return res.json({ assistantMessage: publicMessage(assistant), localInference: false });
  } catch (error) {
    return sendError(res, error, 'Could not create Crowdwide AI fallback response');
  }
};

exports.saveLocalAnswer = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Message not found.' });
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!content || content.length > 12000) return res.status(400).json({ error: 'Responses must be 1–12,000 characters.' });
    const userMessage = await AiMessage.findOne({ _id: req.params.id, user: ownerId(req), role: 'user' })
      .select('conversation sources');
    if (!userMessage) return res.status(404).json({ error: 'Message not found.' });
    const conversation = await AiConversation.exists({ _id: userMessage.conversation, user: ownerId(req) });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
    await AiMessage.deleteMany({
      user: ownerId(req),
      conversation: userMessage.conversation,
      role: 'assistant',
      replyTo: userMessage._id
    });
    const assistant = await addAssistant(
      userMessage.conversation,
      ownerId(req),
      userMessage._id,
      content,
      userMessage.sources
    );
    return res.status(201).json({ assistantMessage: publicMessage(assistant) });
  } catch (error) {
    return sendError(res, error, 'Could not save local Crowdwide AI response');
  }
};

exports.getPreferences = async (req, res) => {
  try {
    const preferences = await getPreferences(ownerId(req));
    return res.json({ preferences: {
      localInference: preferences.localInference,
      inferenceDevice: preferences.inferenceDevice || 'auto',
      theme: preferences.theme
    } });
  } catch (error) {
    return sendError(res, error, 'Could not load Crowdwide AI settings');
  }
};

exports.updatePreferences = async (req, res) => {
  try {
    const update = {};
    if (typeof req.body?.localInference === 'boolean') {
      update.localInference = req.body.localInference;
      update.localInferenceDefaultMigrated = true;
    }
    if (['auto', 'cpu', 'gpu'].includes(req.body?.inferenceDevice)) update.inferenceDevice = req.body.inferenceDevice;
    if (['auto', 'light', 'dark'].includes(req.body?.theme)) update.theme = req.body.theme;
    if (!Object.keys(update).length) return res.status(400).json({ error: 'Choose a supported AI setting to update.' });
    const preferences = await AiPreference.findOneAndUpdate(
      { user: ownerId(req) },
      { $set: update, $setOnInsert: { user: ownerId(req) } },
      { upsert: true, new: true, runValidators: true }
    ).lean();
    return res.json({ preferences: {
      localInference: preferences.localInference,
      inferenceDevice: preferences.inferenceDevice || 'auto',
      theme: preferences.theme
    } });
  } catch (error) {
    return sendError(res, error, 'Could not save Crowdwide AI settings');
  }
};

exports.listMemories = async (req, res) => {
  try {
    const memories = await AiMemory.find({ user: ownerId(req) }).sort({ updatedAt: -1 }).limit(50).lean();
    return res.json({ memories: memories.map((memory) => ({
      id: String(memory._id),
      kind: memory.kind,
      text: memory.text,
      updatedAt: memory.updatedAt
    })) });
  } catch (error) {
    return sendError(res, error, 'Could not load Crowdwide AI memories');
  }
};

exports.createMemory = async (req, res) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    const kind = ['preference', 'ongoing_task', 'summary'].includes(req.body?.kind) ? req.body.kind : 'preference';
    if (!text || text.length > 1000) return res.status(400).json({ error: 'Memory must be 1–1,000 characters.' });
    const count = await AiMemory.countDocuments({ user: ownerId(req) });
    if (count >= 50) return res.status(409).json({ error: 'You have reached the 50-memory limit. Edit or remove an existing memory first.' });
    const memory = await AiMemory.create({ user: ownerId(req), kind, text });
    return res.status(201).json({ memory: { id: String(memory._id), kind: memory.kind, text: memory.text, updatedAt: memory.updatedAt } });
  } catch (error) {
    return sendError(res, error, 'Could not save Crowdwide AI memory');
  }
};

exports.updateMemory = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Memory not found.' });
    const update = {};
    if (typeof req.body?.text === 'string' && req.body.text.trim() && req.body.text.trim().length <= 1000) update.text = req.body.text.trim();
    if (['preference', 'ongoing_task', 'summary'].includes(req.body?.kind)) update.kind = req.body.kind;
    if (!Object.keys(update).length) return res.status(400).json({ error: 'Provide valid memory text or a supported type.' });
    const memory = await AiMemory.findOneAndUpdate(
      { _id: req.params.id, user: ownerId(req) },
      { $set: update },
      { new: true, runValidators: true }
    ).lean();
    if (!memory) return res.status(404).json({ error: 'Memory not found.' });
    return res.json({ memory: { id: String(memory._id), kind: memory.kind, text: memory.text, updatedAt: memory.updatedAt } });
  } catch (error) {
    return sendError(res, error, 'Could not update Crowdwide AI memory');
  }
};

exports.deleteMemory = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Memory not found.' });
    const result = await AiMemory.deleteOne({ _id: req.params.id, user: ownerId(req) });
    if (!result.deletedCount) return res.status(404).json({ error: 'Memory not found.' });
    return res.json({ ok: true });
  } catch (error) {
    return sendError(res, error, 'Could not delete Crowdwide AI memory');
  }
};

exports.feedback = async (req, res) => {
  try {
    if (!isValidId(req.params.id) || !['helpful', 'unhelpful', null].includes(req.body?.feedback)) {
      return res.status(400).json({ error: 'Choose helpful or unhelpful feedback.' });
    }
    const result = await AiMessage.updateOne(
      { _id: req.params.id, user: ownerId(req), role: 'assistant' },
      { $set: { feedback: req.body.feedback } }
    );
    if (!result.matchedCount) return res.status(404).json({ error: 'Response not found.' });
    return res.json({ ok: true });
  } catch (error) {
    return sendError(res, error, 'Could not save Crowdwide AI feedback');
  }
};

exports.confirmAction = async (req, res) => {
  try {
    if (req.body?.confirm !== true) return res.status(400).json({ error: 'Explicit confirmation is required.' });
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Action not found.' });
    const action = await AiAction.findOne({
      _id: req.params.id,
      user: ownerId(req),
      status: 'pending',
      expiresAt: { $gt: new Date() }
    });
    if (!action || !await AiConversation.exists({ _id: action.conversation, user: ownerId(req) })) {
      return res.status(404).json({ error: 'That action is expired or no longer available.' });
    }
    if (['edit_post', 'delete_post', 'create_comment', 'reply_comment'].includes(action.kind)) {
      const post = await Post.findOne({ _id: action.post, author: ownerId(req) }).select('revision').lean();
      if (['edit_post', 'delete_post'].includes(action.kind) && !post) {
        return res.status(404).json({ error: 'That post is no longer available or is not yours.' });
      }
      if (['create_comment', 'reply_comment'].includes(action.kind)) {
        const accessiblePost = await Post.findById(action.post).select('_id author status community').lean();
        if (!accessiblePost || !await canAccessPost(accessiblePost, ownerId(req))) {
          return res.status(404).json({ error: 'That discussion is no longer available.' });
        }
        const restriction = await checkPostingRestriction(ownerId(req));
        if (restriction) return res.status(403).json({ error: restriction });
      }
      if (action.kind === 'edit_post' && (post.revision || 0) !== (action.revision || 0)) {
        return res.status(409).json({ error: 'That post has changed since this proposal. Ask Crowdwide AI to prepare a fresh edit.' });
      }
      if (action.kind === 'reply_comment' && !await Comment.exists({ _id: action.comment, post: action.post })) {
        return res.status(404).json({ error: 'That comment is no longer available in this discussion.' });
      }
    } else if (action.kind === 'send_message' && action.group) {
      const group = await GroupConversation.exists({ _id: action.group, members: ownerId(req) });
      if (!group) return res.status(404).json({ error: 'That group is no longer available for messaging.' });
    } else if (action.kind === 'send_message') {
      const [recipient, viewer] = await Promise.all([
        User.findById(action.recipient).select('_id isVerified blockedUsers').lean(),
        User.findById(ownerId(req)).select('blockedUsers').lean()
      ]);
      if (!recipient?.isVerified ||
          (viewer?.blockedUsers || []).some((id) => String(id) === String(recipient._id)) ||
          (recipient.blockedUsers || []).some((id) => String(id) === String(ownerId(req)))) {
        return res.status(404).json({ error: 'That conversation is no longer available for messaging.' });
      }
    } else {
      const restriction = await checkPostingRestriction(ownerId(req));
      if (restriction) return res.status(403).json({ error: restriction });
    }
    const changed = await AiAction.updateOne(
      { _id: action._id, user: ownerId(req), status: 'pending', expiresAt: { $gt: new Date() } },
      { $set: { status: 'confirmed' } }
    );
    if (!changed.modifiedCount) return res.status(409).json({ error: 'This action was already confirmed or expired.' });
    return res.json({
      action: {
        ...publicAction(action,
          action.post ? `/posts/${action.post}${action.comment ? `#comment-${action.comment}` : ''}` : action.group ? `/groups/${action.group}` : action.recipient ? `/messages/${action.recipient}` : ''
        ),
        revision: action.revision
      }
    });
  } catch (error) {
    return sendError(res, error, 'Could not confirm Crowdwide AI action');
  }
};

exports.cancelAction = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Action not found.' });
    const action = await AiAction.findOneAndUpdate(
      { _id: req.params.id, user: ownerId(req), status: 'pending', expiresAt: { $gt: new Date() } },
      { $set: { status: 'canceled' } },
      { new: true }
    ).select('status');
    if (!action) return res.status(404).json({ error: 'Action is no longer available.' });
    return res.json({ status: action.status });
  } catch (error) {
    return sendError(res, error, 'Could not cancel Crowdwide AI action');
  }
};

exports.completeAction = async (req, res) => {
  try {
    if (!isValidId(req.params.id) || typeof req.body?.success !== 'boolean') {
      return res.status(400).json({ error: 'A valid action result is required.' });
    }
    const action = await AiAction.findOne({ _id: req.params.id, user: ownerId(req) }).select('status resultId');
    if (!action) return res.status(404).json({ error: 'Confirmed action not found.' });
    if (action.status === 'completed') return res.json({ status: action.status, resultId: action.resultId });
    if (action.status !== 'confirmed') return res.status(409).json({ error: 'That action is not awaiting completion.' });
    if (req.body.success === false) {
      const failed = await AiAction.findOneAndUpdate(
        { _id: action._id, user: ownerId(req), status: 'confirmed' },
        { $set: { status: 'failed', failureReason: String(req.body.error || 'The platform action did not complete.').trim().slice(0, 300) } },
        { new: true }
      ).select('status');
      if (!failed) return res.status(409).json({ error: 'That action result was already recorded.' });
      return res.json({ status: failed.status });
    }
    return res.status(409).json({ error: 'The platform action did not record a completed result.' });
  } catch (error) {
    return sendError(res, error, 'Could not record Crowdwide AI action result');
  }
};

