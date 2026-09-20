// Direct messages and group chats.
//
// Both kinds of chat share one shape:
//   GET  <thread>          full page (last 40 messages, newest at the bottom)
//   GET  <thread>/poll     messages newer than ?after=<id>      (JSON, HTML per message)
//   GET  <thread>/history  messages older than ?before=<id>     (JSON, HTML per message)
//   POST <thread>          send text and/or a GIF               (JSON for the page, redirect without JS)
//
// The browser sends and receives messages in the background, so the page is
// never reloaded while chatting. Every message the server returns is already
// rendered HTML (partials/chat-message), which keeps a single renderer for
// first load, sends, polls and history.

const Message = require('../models/Message');
const GroupConversation = require('../models/GroupConversation');
const GroupMessage = require('../models/GroupMessage');
const Notification = require('../models/Notification');
const User = require('../models/User');
const logger = require('../services/logger');
const { gifFromBody } = require('../services/gif');
const { PAGE_SIZE, isObjectId, previewText, attachPostPreviews } = require('../services/chat');
const { notify } = require('./interactionController');

const NOTIFY_QUIET_MS = 10 * 60 * 1000;
const isXhr = (req) => req.get('X-Requested-With') === 'XMLHttpRequest';

function renderPartial(res, view, data) {
  return new Promise((resolve, reject) => res.render(view, data, (error, html) => (error ? reject(error) : resolve(html))));
}

async function renderMessages(res, messages, { group, viewerId }) {
  return Promise.all(messages.map(async (message) => ({
    id: String(message._id),
    createdAt: message.createdAt,
    html: (await renderPartial(res, 'partials/chat-message', { message, group, viewerId })).trim()
  })));
}

function memberOf(group, userId) {
  return group?.members?.some((member) => String(member?._id || member) === String(userId));
}

// One notification per burst: while the recipient still has an unread message
// notification from this sender, further messages do not create (or push) more.
async function notifyMessage({ recipient, actor, text, actorName, url }) {
  const recent = await Notification.exists({ recipient, actor, type: 'message', readAt: null, createdAt: { $gt: new Date(Date.now() - NOTIFY_QUIET_MS) } });
  if (recent) return;
  await notify(recipient, actor, 'message', text, undefined, undefined, actorName, url);
}

// ---- helpers shared by DM and group flows ---------------------------------

async function pageOfMessages(Model, filter, { after, before }) {
  if (after) {
    return { rows: await Model.find({ ...filter, _id: { $gt: after } }).sort({ _id: 1 }).limit(50).populate('sender', 'name profilePicture').lean(), hasMore: false };
  }
  const query = before ? { ...filter, _id: { $lt: before } } : filter;
  const rows = await Model.find(query).sort({ _id: -1 }).limit(PAGE_SIZE + 1).populate('sender', 'name profilePicture').lean();
  return { rows: rows.slice(0, PAGE_SIZE).reverse(), hasMore: rows.length > PAGE_SIZE };
}

function sanitizedContent(req) {
  const body = String(req.body.body || '').trim();
  const gif = gifFromBody(req.body);
  return { body, gif };
}

function sendFailure(req, res, status, error, redirectTo) {
  if (isXhr(req)) return res.status(status).json({ ok: false, error });
  req.session.flash = { type: 'error', message: error };
  return res.redirect(redirectTo);
}

// ---- direct messages ------------------------------------------------------

const dmFilter = (a, b) => ({ $or: [{ sender: a, recipient: b }, { sender: b, recipient: a }] });

async function loadDmPerson(req) {
  const userId = req.session.user.id;
  const person = await User.findById(req.params.id).select('name profilePicture blockedUsers isVerified').lean();
  if (!person || String(person._id) === String(userId)) return { person: null };
  const viewer = await User.findById(userId).select('blockedUsers').lean();
  const blocked = (viewer?.blockedUsers || []).some((id) => String(id) === String(person._id)) || (person.blockedUsers || []).some((id) => String(id) === String(userId));
  return { person, blocked, userId };
}

exports.dmThread = async (req, res) => {
  try {
    const { person, blocked, userId } = await loadDmPerson(req);
    if (!person) return res.redirect('/messages');
    if (blocked) {
      req.session.flash = { type: 'error', message: 'Messaging is unavailable for this account.' };
      return res.redirect('/messages');
    }
    await Message.updateMany({ sender: person._id, recipient: userId, readAt: null }, { readAt: new Date() });
    const { rows, hasMore } = await pageOfMessages(Message, dmFilter(userId, person._id), {});
    await attachPostPreviews(rows, userId);
    const rendered = await renderMessages(res, rows, { group: false, viewerId: userId });
    res.render('pages/message-thread', {
      title: `Messages with ${person.name}`,
      pagePath: `/messages/${person._id}`,
      noIndex: true,
      person,
      messagesHtml: rendered.map((item) => item.html).join('\n'),
      lastId: rows.length ? String(rows[rows.length - 1]._id) : '',
      hasMore
    });
  } catch (error) {
    logger.error('Loading message thread failed', error);
    res.status(500).render('pages/not-found', { title: 'Crowdwide is having trouble' });
  }
};

exports.dmPoll = async (req, res) => {
  try {
    const { person, blocked, userId } = await loadDmPerson(req);
    if (!person || blocked) return res.status(404).json({ messages: [] });
    const after = isObjectId(req.query.after) ? req.query.after : null;
    const before = isObjectId(req.query.before) ? req.query.before : null;
    const { rows, hasMore } = await pageOfMessages(Message, dmFilter(userId, person._id), { after, before });
    if (after && rows.some((row) => String(row.sender?._id) === String(person._id))) {
      await Message.updateMany({ sender: person._id, recipient: userId, readAt: null }, { readAt: new Date() });
    }
    await attachPostPreviews(rows, userId);
    res.json({ messages: await renderMessages(res, rows, { group: false, viewerId: userId }), hasMore });
  } catch (error) {
    logger.error('Polling direct messages failed', error);
    res.status(500).json({ messages: [], error: 'Could not load messages.' });
  }
};

exports.dmSend = async (req, res) => {
  const fallback = `/messages/${req.params.id}`;
  try {
    const userId = req.session.user.id;
    const { body, gif } = sanitizedContent(req);
    if ((!body && !gif) || body.length > 2000) return sendFailure(req, res, 400, 'Write a message (up to 2,000 characters) or pick a GIF.', fallback);
    const recipient = await User.findById(req.params.id).select('_id isVerified blockedUsers').lean();
    const viewer = await User.findById(userId).select('blockedUsers').lean();
    const blocked = recipient && ((viewer?.blockedUsers || []).some((id) => String(id) === String(recipient._id)) || (recipient.blockedUsers || []).some((id) => String(id) === String(userId)));
    if (!recipient || !recipient.isVerified || blocked || String(recipient._id) === String(userId)) return sendFailure(req, res, 403, 'That message could not be sent.', '/messages');
    const message = await Message.create({ sender: userId, recipient: recipient._id, body, ...(gif ? { gif } : {}) });
    notifyMessage({ recipient: recipient._id, actor: userId, text: gif && !body ? 'sent you a GIF.' : 'sent you a message.', actorName: req.session.user.name, url: `/messages/${userId}` })
      .catch((error) => logger.error('Message notification failed', error));
    if (!isXhr(req)) return res.redirect(fallback);
    const shaped = { ...message.toObject(), sender: { _id: userId, name: req.session.user.name, profilePicture: req.session.user.profilePicture } };
    const [item] = await renderMessages(res, [shaped], { group: false, viewerId: userId });
    res.json({ ok: true, message: item, clientId: req.body.clientId || null });
  } catch (error) {
    logger.error('Sending message failed', error);
    sendFailure(req, res, 500, 'That message could not be sent.', fallback);
  }
};

// ---- group chats ----------------------------------------------------------

async function loadGroup(req) {
  const group = await GroupConversation.findById(req.params.id).populate('members', 'name profilePicture').lean();
  if (!group || !memberOf(group, req.session.user.id)) return null;
  return group;
}

exports.groupThread = async (req, res) => {
  try {
    const group = await loadGroup(req);
    if (!group) return res.status(404).render('pages/not-found', { title: 'Group not found' });
    const userId = req.session.user.id;
    const { rows, hasMore } = await pageOfMessages(GroupMessage, { group: group._id }, {});
    await attachPostPreviews(rows, userId);
    const rendered = await renderMessages(res, rows, { group: true, viewerId: userId });
    res.render('pages/group-thread', {
      title: group.name,
      pagePath: `/groups/${group._id}`,
      noIndex: true,
      group,
      messagesHtml: rendered.map((item) => item.html).join('\n'),
      lastId: rows.length ? String(rows[rows.length - 1]._id) : '',
      hasMore
    });
  } catch (error) {
    logger.error('Loading group thread failed', error);
    res.status(500).render('pages/not-found', { title: 'Crowdwide is having trouble' });
  }
};

exports.groupPoll = async (req, res) => {
  try {
    const group = await GroupConversation.findById(req.params.id).select('members').lean();
    if (!memberOf(group, req.session.user.id)) return res.status(404).json({ messages: [] });
    const userId = req.session.user.id;
    const after = isObjectId(req.query.after) ? req.query.after : null;
    const before = isObjectId(req.query.before) ? req.query.before : null;
    const { rows, hasMore } = await pageOfMessages(GroupMessage, { group: group._id }, { after, before });
    await attachPostPreviews(rows, userId);
    res.json({ messages: await renderMessages(res, rows, { group: true, viewerId: userId }), hasMore });
  } catch (error) {
    logger.error('Polling group messages failed', error);
    res.status(500).json({ messages: [], error: 'Could not load messages.' });
  }
};

exports.groupSend = async (req, res) => {
  const fallback = `/groups/${req.params.id}`;
  try {
    const userId = req.session.user.id;
    const group = await GroupConversation.findById(req.params.id).select('members name');
    const { body, gif } = sanitizedContent(req);
    if (!memberOf(group, userId)) return sendFailure(req, res, 403, 'That message could not be sent.', '/groups');
    if ((!body && !gif) || body.length > 2000) return sendFailure(req, res, 400, 'Write a message (up to 2,000 characters) or pick a GIF.', fallback);
    const message = await GroupMessage.create({ group: group._id, sender: userId, body, ...(gif ? { gif } : {}) });
    await GroupConversation.updateOne({ _id: group._id }, { updatedAt: new Date() });
    const others = group.members.filter((id) => String(id) !== String(userId));
    Promise.all(others.map((memberId) => notifyMessage({ recipient: memberId, actor: userId, text: `sent a message in ${group.name}.`, actorName: req.session.user.name, url: `/groups/${group._id}` })))
      .catch((error) => logger.error('Group message notification failed', error));
    if (!isXhr(req)) return res.redirect(fallback);
    const shaped = { ...message.toObject(), sender: { _id: userId, name: req.session.user.name, profilePicture: req.session.user.profilePicture } };
    const [item] = await renderMessages(res, [shaped], { group: true, viewerId: userId });
    res.json({ ok: true, message: item, clientId: req.body.clientId || null });
  } catch (error) {
    logger.error('Sending group message failed', error);
    sendFailure(req, res, 500, 'That message could not be sent.', fallback);
  }
};

exports.notifyMessage = notifyMessage;
exports.memberOf = memberOf;
exports.previewText = previewText;
