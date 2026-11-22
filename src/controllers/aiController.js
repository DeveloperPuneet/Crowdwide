const mongoose = require('mongoose');
const AiAction = require('../models/AiAction');
const AiConversation = require('../models/AiConversation');
const AiMemory = require('../models/AiMemory');
const AiMessage = require('../models/AiMessage');
const AiPreference = require('../models/AiPreference');
const Post = require('../models/Post');
const logger = require('../services/logger');
const { checkPostingRestriction } = require('../utils/postingRestriction');
const {
  buildFallbackResponse,
  executeCrowdwideTools,
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

async function createActionProposal(actionRequest, { userId, conversationId }) {
  let post = null;
  if (actionRequest.kind === 'create_post') {
    if (!actionRequest.content || actionRequest.content.length > 4000) {
      return { error: 'A new post must contain 1–4,000 characters.' };
    }
    const restriction = await checkPostingRestriction(userId);
    if (restriction) return { error: restriction };
  } else {
    if (!isValidId(actionRequest.postId)) return { error: 'That post ID is not valid.' };
    post = await Post.findOne({ _id: actionRequest.postId, author: userId })
      .select('_id body revision')
      .lean();
    if (!post) return { error: 'I could not find a post you own with that ID.' };
    if (actionRequest.kind === 'edit_post' && (!actionRequest.content || actionRequest.content.length > 4000)) {
      return { error: 'An edited post must contain 1–4,000 characters.' };
    }
  }
  const action = await AiAction.create({
    user: userId,
    conversation: conversationId,
    kind: actionRequest.kind,
    post: post?._id || null,
    postPreview: post?.body ? post.body.slice(0, 180) : '',
    content: actionRequest.content || '',
    revision: post ? post.revision || 0 : null,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000)
  });
  return {
    action,
    preview: {
      id: String(action._id),
      kind: action.kind,
      postId: action.post ? String(action.post) : null,
      content: action.content,
      status: action.status,
      postPreview: post?.body ? post.body.slice(0, 180) : ''
    }
  };
}

async function prepareTurn({ userId, conversation, content }) {
  const preferences = await getPreferences(userId);
  const memories = preferences.localInference
    ? await AiMemory.find({ user: userId }).sort({ updatedAt: -1 }).limit(10).select('kind text updatedAt').lean()
    : [];
  const actionRequest = parseActionRequest(content);
  const result = actionRequest
    ? { tool: 'action', action: actionRequest, sources: [], context: [], summary: '' }
    : await executeCrowdwideTools({ query: content, userId });
  const userMessage = await AiMessage.create({
    user: userId,
    conversation: conversation._id,
    role: 'user',
    content,
    sources: result.sources,
    context: result.context
  });
  const update = { lastMessageAt: new Date() };
  if (conversation.title === 'New conversation') update.title = titleFromPrompt(content);
  await AiConversation.updateOne({ _id: conversation._id, user: userId }, { $set: update });

  if (actionRequest) {
    const proposal = await createActionProposal(actionRequest, { userId, conversationId: conversation._id });
    const text = proposal.error
      ? `I couldn't prepare that action: ${proposal.error}`
      : `${actionRequest.kind === 'create_post' ? 'I can publish this as a post' : actionRequest.kind === 'edit_post' ? 'I can update your post' : 'I can delete your post'}. Nothing changes until you confirm below.`;
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
      ? await AiAction.find({ _id: { $in: actionIds }, user: ownerId(req) }).select('kind post postPreview content status').lean()
      : [];
    const actionsById = new Map(actions.map((action) => [String(action._id), action]));
    return res.json({ messages: messages.map((message) => {
      const action = message.actionId && actionsById.get(String(message.actionId));
      return publicMessage(message, action ? {
        id: String(message.actionId),
        kind: action.kind,
        postId: action.post ? String(action.post) : null,
        postPreview: action.postPreview,
        content: action.content,
        status: action.status
      } : null);
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
    const conversation = await AiConversation.findOne({ _id: req.params.id, user: ownerId(req) });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
    return res.json(await prepareTurn({ userId: ownerId(req), conversation, content }));
  } catch (error) {
    return sendError(res, error, 'Crowdwide AI could not process a message');
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
    return res.json({ preferences: { localInference: preferences.localInference, theme: preferences.theme } });
  } catch (error) {
    return sendError(res, error, 'Could not load Crowdwide AI settings');
  }
};

exports.updatePreferences = async (req, res) => {
  try {
    const update = {};
    if (typeof req.body?.localInference === 'boolean') update.localInference = req.body.localInference;
    if (['auto', 'light', 'dark'].includes(req.body?.theme)) update.theme = req.body.theme;
    if (!Object.keys(update).length) return res.status(400).json({ error: 'Choose a supported AI setting to update.' });
    const preferences = await AiPreference.findOneAndUpdate(
      { user: ownerId(req) },
      { $set: update, $setOnInsert: { user: ownerId(req) } },
      { upsert: true, new: true, runValidators: true }
    ).lean();
    return res.json({ preferences: { localInference: preferences.localInference, theme: preferences.theme } });
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
    if (action.kind !== 'create_post') {
      const post = await Post.findOne({ _id: action.post, author: ownerId(req) }).select('revision').lean();
      if (!post) return res.status(404).json({ error: 'That post is no longer available or is not yours.' });
      if (action.kind === 'edit_post' && (post.revision || 0) !== (action.revision || 0)) {
        return res.status(409).json({ error: 'That post has changed since this proposal. Ask Crowdwide AI to prepare a fresh edit.' });
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
        id: String(action._id),
        kind: action.kind,
        postId: action.post ? String(action.post) : null,
        content: action.content,
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
    const existing = await AiAction.findOne({ _id: req.params.id, user: ownerId(req), status: 'confirmed' });
    if (!existing) return res.status(404).json({ error: 'Confirmed action not found.' });
    const update = { status: req.body.success ? 'completed' : 'failed' };
    if (req.body.success && existing.kind === 'create_post') {
      if (!isValidId(req.body.postId) || !await Post.exists({ _id: req.body.postId, author: ownerId(req) })) {
        return res.status(400).json({ error: 'A newly created post owned by you is required.' });
      }
      update.post = req.body.postId;
    }
    const action = await AiAction.findOneAndUpdate(
      { _id: existing._id, user: ownerId(req), status: 'confirmed' },
      { $set: update },
      { new: true }
    ).select('status');
    if (!action) return res.status(404).json({ error: 'Confirmed action not found.' });
    return res.json({ status: action.status });
  } catch (error) {
    return sendError(res, error, 'Could not record Crowdwide AI action result');
  }
};

