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
const Report = require('../models/Report');
const User = require('../models/User');
const logger = require('../services/logger');
const { gifFromBody } = require('../services/gif');
const { PAGE_SIZE, isObjectId, escapeRegex, excerpt, previewText, attachPostPreviews, isPendingRequest, tooManyNewDmRequests } = require('../services/chat');
const { parseRange } = require('../services/storageCluster');
const { notify } = require('./interactionController');
const { toggleReaction } = require('../utils/reactions');

const NOTIFY_QUIET_MS = 10 * 60 * 1000;
const isXhr = (req) => req.get('X-Requested-With') === 'XMLHttpRequest';

function renderPartial(res, view, data) {
  return new Promise((resolve, reject) => res.render(view, data, (error, html) => (error ? reject(error) : resolve(html))));
}

async function renderMessages(res, messages, { group, viewerId, groupId, reportBaseUrl }) {
  return Promise.all(messages.map(async (message) => ({
    id: String(message._id),
    createdAt: message.createdAt,
    html: (await renderPartial(res, 'partials/chat-message', { message, group, viewerId, groupId, reportBaseUrl, csrfToken: res.locals.csrfToken })).trim()
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
    return { rows: await Model.find({ ...filter, _id: { $gt: after } }).sort({ _id: 1 }).limit(50).select('-attachment.data').populate('sender', 'name profilePicture').lean(), hasMore: false };
  }
  const query = before ? { ...filter, _id: { $lt: before } } : filter;
  const rows = await Model.find(query).sort({ _id: -1 }).limit(PAGE_SIZE + 1).select('-attachment.data').populate('sender', 'name profilePicture').lean();
  return { rows: rows.slice(0, PAGE_SIZE).reverse(), hasMore: rows.length > PAGE_SIZE };
}

async function pageAroundMessage(Model, filter, focusId) {
  const target = await Model.findOne({ ...filter, _id: focusId }).select('_id').lean();
  if (!target) return pageOfMessages(Model, filter, {});
  const halfPage = Math.ceil(PAGE_SIZE / 2);
  const [before, fromTarget] = await Promise.all([
    Model.find({ ...filter, _id: { $lt: target._id } }).sort({ _id: -1 }).limit(halfPage + 1).select('-attachment.data').populate('sender', 'name profilePicture').lean(),
    Model.find({ ...filter, _id: { $gte: target._id } }).sort({ _id: 1 }).limit(halfPage).select('-attachment.data').populate('sender', 'name profilePicture').lean()
  ]);
  return { rows: [...before.slice(0, halfPage).reverse(), ...fromTarget], hasMore: before.length > halfPage };
}

function searchQuery(req, res) {
  const query = String(req.query.q || '').trim().slice(0, 100);
  if (query.length < 2) {
    res.status(400).json({ ok: false, error: 'Enter at least 2 characters to search.' });
    return null;
  }
  return new RegExp(escapeRegex(query), 'i');
}

function shapeSearchResults(rows, href) {
  return rows.map((row) => ({
    id: String(row._id),
    sender: row.sender?.name || 'Member',
    excerpt: excerpt(row.body, 180),
    createdAt: row.createdAt,
    href: `${href}?focus=${row._id}`
  }));
}

function sanitizedContent(req) {
  const body = String(req.body.body || '').trim();
  const gif = gifFromBody(req.body);
  const attachment = req.file ? {
    filename: req.file.safeFilename,
    contentType: req.file.safeContentType,
    size: req.file.size,
    data: req.file.buffer
  } : null;
  return { body, gif, attachment };
}

function sendMessageAttachment(res, message, req) {
  if (!message?.attachment?.data) return res.status(404).end();
  const { filename, contentType, size, data } = message.attachment;
  const fallbackName = String(filename || 'attachment').replace(/[^\x20-\x7e]|["\\]/g, '_');
  const isPreviewableMedia = /^image\//.test(contentType) || /^video\//.test(contentType);
  res.set({
    'Content-Type': contentType,
    'Content-Disposition': `${isPreviewableMedia ? 'inline' : 'attachment'}; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(filename || 'attachment')}`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  const isVideo = /^video\//.test(contentType);
  if (isVideo) res.set('Accept-Ranges', 'bytes');
  const videoRange = isVideo ? parseRange(req?.headers?.range, size) : null;
  if (videoRange === 'unsatisfiable') {
    res.set({ 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' });
    return res.status(416).end();
  }
  if (videoRange) {
    const length = videoRange.end - videoRange.start + 1;
    res.set({
      'Content-Range': `bytes ${videoRange.start}-${videoRange.end}/${size}`,
      'Content-Length': String(length)
    });
    if (req?.method === 'HEAD') return res.status(206).end();
    return res.status(206).send(data.subarray(videoRange.start, videoRange.end + 1));
  }
  res.set('Content-Length', String(size));
  if (req?.method === 'HEAD') return res.end();
  res.send(data);
}

function sendFailure(req, res, status, error, redirectTo) {
  if (isXhr(req)) return res.status(status).json({ ok: false, error });
  req.session.flash = { type: 'error', message: error };
  return res.redirect(redirectTo);
}

exports.sendMessageAttachment = sendMessageAttachment;

// ---- direct messages ------------------------------------------------------

const dmFilter = (a, b) => ({ $or: [{ sender: a, recipient: b }, { sender: b, recipient: a }] });

async function loadDmPerson(req) {
  const userId = req.session.user.id;
  const person = await User.findById(req.params.id).select('name profilePicture blockedUsers isVerified').lean();
  if (!person || String(person._id) === String(userId)) return { person: null };
  const viewer = await User.findById(userId).select('blockedUsers acceptedDmFrom declinedDmFrom').lean();
  const blocked = (viewer?.blockedUsers || []).some((id) => String(id) === String(person._id)) || (person.blockedUsers || []).some((id) => String(id) === String(userId));
  return { person, blocked, userId, viewer };
}

// See src/services/chat.js#isPendingRequest for what "pending" means.
async function pendingRequestFlag(viewer, viewerId, otherId) {
  const [viewerHasSent, otherHasSent] = await Promise.all([
    Message.exists({ sender: viewerId, recipient: otherId }),
    Message.exists({ sender: otherId, recipient: viewerId })
  ]);
  const accepted = (viewer?.acceptedDmFrom || []).some((id) => String(id) === String(otherId));
  const declined = (viewer?.declinedDmFrom || []).some((id) => String(id) === String(otherId));
  return Boolean(otherHasSent) && isPendingRequest({ viewerHasSent: Boolean(viewerHasSent), accepted, declined });
}

exports.dmThread = async (req, res) => {
  try {
    const { person, blocked, userId, viewer } = await loadDmPerson(req);
    if (!person) return res.redirect('/messages');
    if (blocked) {
      req.session.flash = { type: 'error', message: 'Messaging is unavailable for this account.' };
      return res.redirect('/messages');
    }
    const pending = await pendingRequestFlag(viewer, userId, person._id);
    await Message.updateMany({ sender: person._id, recipient: userId, readAt: null }, { readAt: new Date() });
    const focusId = isObjectId(req.query.focus) ? req.query.focus : null;
    const { rows, hasMore } = focusId
      ? await pageAroundMessage(Message, dmFilter(userId, person._id), focusId)
      : await pageOfMessages(Message, dmFilter(userId, person._id), {});
    await attachPostPreviews(rows, userId);
    const rendered = await renderMessages(res, rows, { group: false, viewerId: userId, reportBaseUrl: `/messages/${person._id}` });
    res.render('pages/message-thread', {
      title: `Messages with ${person.name}`,
      pagePath: `/messages/${person._id}`,
      noIndex: true,
      person,
      messagesHtml: rendered.map((item) => item.html).join('\n'),
      lastId: rows.length ? String(rows[rows.length - 1]._id) : '',
      hasMore,
      focusId,
      pending
    });
  } catch (error) {
    logger.error('Loading message thread failed', error);
    res.status(500).render('pages/not-found', { title: 'Crowdwide is having trouble' });
  }
};

exports.dmSearch = async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(404).json({ ok: false, results: [] });
    const regex = searchQuery(req, res);
    if (!regex) return;
    const { person, blocked, userId } = await loadDmPerson(req);
    if (!person || blocked) return res.status(404).json({ ok: false, results: [] });
    const rows = await Message.find({ ...dmFilter(userId, person._id), body: regex })
      .sort({ createdAt: -1 }).limit(20).select('body sender createdAt').populate('sender', 'name').lean();
    res.json({ ok: true, results: shapeSearchResults(rows, `/messages/${person._id}`) });
  } catch (error) {
    logger.error('Searching direct messages failed', error);
    res.status(500).json({ ok: false, error: 'Could not search this conversation.', results: [] });
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
    res.json({ messages: await renderMessages(res, rows, { group: false, viewerId: userId, reportBaseUrl: `/messages/${person._id}` }), hasMore });
  } catch (error) {
    logger.error('Polling direct messages failed', error);
    res.status(500).json({ messages: [], error: 'Could not load messages.' });
  }
};

exports.dmHistory = async (req, res) => {
  try {
    const { person, blocked, userId } = await loadDmPerson(req);
    const before = isObjectId(req.query.before) ? req.query.before : null;
    if (!person || blocked || !before) return res.status(404).json({ messages: [], hasMore: false });
    const { rows, hasMore } = await pageOfMessages(Message, dmFilter(userId, person._id), { before });
    await attachPostPreviews(rows, userId);
    res.json({ messages: await renderMessages(res, rows, { group: false, viewerId: userId, reportBaseUrl: `/messages/${person._id}` }), hasMore });
  } catch (error) {
    logger.error('Loading earlier direct messages failed', error);
    res.status(500).json({ messages: [], hasMore: false, error: 'Could not load earlier messages.' });
  }
};

exports.dmSend = async (req, res) => {
  const fallback = `/messages/${req.params.id}`;
  try {
    const userId = req.session.user.id;
    const { body, gif, attachment } = sanitizedContent(req);
    if ((!body && !gif && !attachment) || body.length > 2000) return sendFailure(req, res, 400, 'Write a message, attach a file, or pick a GIF. Text is limited to 2,000 characters.', fallback);
    const recipient = await User.findById(req.params.id).select('_id isVerified blockedUsers').lean();
    const viewer = await User.findById(userId).select('blockedUsers acceptedDmFrom').lean();
    const blocked = recipient && ((viewer?.blockedUsers || []).some((id) => String(id) === String(recipient._id)) || (recipient.blockedUsers || []).some((id) => String(id) === String(userId)));
    if (!recipient || !recipient.isVerified || blocked || String(recipient._id) === String(userId)) return sendFailure(req, res, 403, 'That message could not be sent.', '/messages');
    // Rate-limit brand-new threads only (never a reply in an existing one),
    // so this can't be used to mass-DM strangers.
    const everMessagedBefore = await Message.exists({ sender: userId, recipient: recipient._id });
    if (!everMessagedBefore && await tooManyNewDmRequests(Message, userId)) {
      return sendFailure(req, res, 429, "You've started a lot of new conversations recently. Try again later.", fallback);
    }
    const message = await Message.create({ sender: userId, recipient: recipient._id, body, ...(gif ? { gif } : {}), ...(attachment ? { attachment } : {}) });
    // Replying to someone (including replying to a pending request from
    // them) is an explicit signal of acceptance - no separate click needed.
    const alreadyAccepted = (viewer?.acceptedDmFrom || []).some((id) => String(id) === String(recipient._id));
    if (!alreadyAccepted) {
      await User.updateOne({ _id: userId }, { $addToSet: { acceptedDmFrom: recipient._id }, $pull: { declinedDmFrom: recipient._id } });
    }
    notifyMessage({ recipient: recipient._id, actor: userId, text: attachment && !body && !gif ? 'sent you an attachment.' : gif && !body ? 'sent you a GIF.' : 'sent you a message.', actorName: req.session.user.name, url: `/messages/${userId}` })
      .catch((error) => logger.error('Message notification failed', error));
    if (!isXhr(req)) return res.redirect(fallback);
    const shaped = { ...message.toObject(), sender: { _id: userId, name: req.session.user.name, profilePicture: req.session.user.profilePicture } };
    const [item] = await renderMessages(res, [shaped], { group: false, viewerId: userId, reportBaseUrl: `/messages/${recipient._id}` });
    res.json({ ok: true, message: item, clientId: req.body.clientId || null });
  } catch (error) {
    logger.error('Sending message failed', error);
    sendFailure(req, res, 500, 'That message could not be sent.', fallback);
  }
};

exports.dmAttachment = async (req, res) => {
  try {
    if (!isObjectId(req.params.id) || !isObjectId(req.params.messageId)) return res.status(404).end();
    const { person, blocked, userId } = await loadDmPerson(req);
    if (!person || blocked) return res.status(404).end();
    const message = await Message.findOne({ _id: req.params.messageId, ...dmFilter(userId, person._id) }).select('attachment').lean();
    return sendMessageAttachment(res, message, req);
  } catch (error) {
    logger.error('Loading direct-message attachment failed', error);
    return res.status(404).end();
  }
};

exports.dmReportMessage = async (req, res) => {
  const fallback = `/messages/${req.params.id}`;
  try {
    const reason = String(req.body.reason || '').trim().slice(0, 500);
    if (!reason) { req.session.flash = { type: 'error', message: 'Choose a reason to report this message.' }; return res.redirect(fallback); }
    if (!isObjectId(req.params.id) || !isObjectId(req.params.messageId)) return res.redirect('/messages');
    const { person, blocked, userId } = await loadDmPerson(req);
    if (!person || blocked) return res.redirect('/messages');
    const message = await Message.findOne({ _id: req.params.messageId, ...dmFilter(userId, person._id) }).select('sender body attachment.filename').populate('sender', 'name').lean();
    if (!message || String(message.sender?._id || message.sender) === String(userId)) return res.redirect(fallback);
    const contextText = `${message.sender?.name || 'Member'}: ${message.body || `[attachment: ${message.attachment?.filename || 'file'}]`}`.slice(0, 3000);
    await Report.updateOne({ reporter: userId, targetType: 'direct-message', target: message._id }, {
      $setOnInsert: { reporter: userId, targetType: 'direct-message', target: message._id, reason, contextText }
    }, { upsert: true });
    req.session.flash = { type: 'success', message: 'Message reported to the moderation team.' };
    res.redirect(fallback);
  } catch (error) {
    logger.error('Reporting direct message failed', error);
    req.session.flash = { type: 'error', message: 'Could not report that message.' };
    res.redirect(fallback);
  }
};

exports.dmReact = async (req, res) => {
  try {
    const userId = req.session.user.id;
    const message = await Message.findById(req.params.id);
    if (!message || ![String(message.sender), String(message.recipient)].includes(String(userId))) return res.status(404).json({ ok: false, error: 'Message not found.' });
    const result = toggleReaction(message.reactions.map((entry) => entry.toObject()), req.body.emoji, userId);
    if (!result) return res.status(400).json({ ok: false, error: 'Unsupported reaction.' });
    message.set('reactions', result.reactions);
    await message.save();
    res.json({ ok: true, reactions: result.summary });
  } catch (error) {
    logger.error('Reacting to a message failed', error);
    res.status(500).json({ ok: false, error: 'Could not react to that message.' });
  }
};

// ---- message requests ------------------------------------------------------

exports.dmRequestRespond = async (req, res) => {
  try {
    const userId = req.session.user.id;
    const otherId = req.params.id;
    if (!isObjectId(otherId)) return res.redirect('/messages/requests');
    const decision = req.body.decision === 'accept' ? 'accept' : 'decline';
    if (decision === 'accept') {
      await User.updateOne({ _id: userId }, { $addToSet: { acceptedDmFrom: otherId }, $pull: { declinedDmFrom: otherId } });
      return res.redirect(`/messages/${otherId}`);
    }
    await User.updateOne({ _id: userId }, { $addToSet: { declinedDmFrom: otherId }, $pull: { acceptedDmFrom: otherId } });
    req.session.flash = { type: 'success', message: 'Request declined.' };
    res.redirect('/messages/requests');
  } catch (error) {
    logger.error('Responding to a message request failed', error);
    res.redirect('/messages/requests');
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
    const focusId = isObjectId(req.query.focus) ? req.query.focus : null;
    const { rows, hasMore } = focusId
      ? await pageAroundMessage(GroupMessage, { group: group._id }, focusId)
      : await pageOfMessages(GroupMessage, { group: group._id }, {});
    await attachPostPreviews(rows, userId);
    const rendered = await renderMessages(res, rows, { group: true, viewerId: userId, groupId: String(group._id), reportBaseUrl: `/groups/${group._id}` });
    res.render('pages/group-thread', {
      title: group.name,
      pagePath: `/groups/${group._id}`,
      noIndex: true,
      group,
      messagesHtml: rendered.map((item) => item.html).join('\n'),
      lastId: rows.length ? String(rows[rows.length - 1]._id) : '',
      hasMore,
      focusId
    });
  } catch (error) {
    logger.error('Loading group thread failed', error);
    res.status(500).render('pages/not-found', { title: 'Crowdwide is having trouble' });
  }
};

exports.groupSearch = async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(404).json({ ok: false, results: [] });
    const regex = searchQuery(req, res);
    if (!regex) return;
    const group = await loadGroup(req);
    if (!group) return res.status(404).json({ ok: false, results: [] });
    const rows = await GroupMessage.find({ group: group._id, kind: { $ne: 'system' }, body: regex })
      .sort({ createdAt: -1 }).limit(20).select('body sender createdAt').populate('sender', 'name').lean();
    res.json({ ok: true, results: shapeSearchResults(rows, `/groups/${group._id}`) });
  } catch (error) {
    logger.error('Searching group messages failed', error);
    res.status(500).json({ ok: false, error: 'Could not search this conversation.', results: [] });
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
    res.json({ messages: await renderMessages(res, rows, { group: true, viewerId: userId, groupId: String(group._id), reportBaseUrl: `/groups/${group._id}` }), hasMore });
  } catch (error) {
    logger.error('Polling group messages failed', error);
    res.status(500).json({ messages: [], error: 'Could not load messages.' });
  }
};

exports.groupHistory = async (req, res) => {
  try {
    const group = await GroupConversation.findById(req.params.id).select('members').lean();
    const before = isObjectId(req.query.before) ? req.query.before : null;
    if (!memberOf(group, req.session.user.id) || !before) return res.status(404).json({ messages: [], hasMore: false });
    const { rows, hasMore } = await pageOfMessages(GroupMessage, { group: group._id }, { before });
    await attachPostPreviews(rows, req.session.user.id);
    res.json({ messages: await renderMessages(res, rows, { group: true, viewerId: req.session.user.id, groupId: String(group._id), reportBaseUrl: `/groups/${group._id}` }), hasMore });
  } catch (error) {
    logger.error('Loading earlier group messages failed', error);
    res.status(500).json({ messages: [], hasMore: false, error: 'Could not load earlier messages.' });
  }
};

exports.groupSend = async (req, res) => {
  const fallback = `/groups/${req.params.id}`;
  try {
    const userId = req.session.user.id;
    const group = await GroupConversation.findById(req.params.id).select('members name');
    const { body, gif, attachment } = sanitizedContent(req);
    if (!memberOf(group, userId)) return sendFailure(req, res, 403, 'That message could not be sent.', '/groups');
    if ((!body && !gif && !attachment) || body.length > 2000) return sendFailure(req, res, 400, 'Write a message, attach a file, or pick a GIF. Text is limited to 2,000 characters.', fallback);
    const message = await GroupMessage.create({ group: group._id, sender: userId, body, ...(gif ? { gif } : {}), ...(attachment ? { attachment } : {}) });
    await GroupConversation.updateOne({ _id: group._id }, { updatedAt: new Date() });
    const others = group.members.filter((id) => String(id) !== String(userId));
    Promise.all(others.map((memberId) => notifyMessage({ recipient: memberId, actor: userId, text: attachment && !body && !gif ? `sent an attachment in ${group.name}.` : `sent a message in ${group.name}.`, actorName: req.session.user.name, url: `/groups/${group._id}` })))
      .catch((error) => logger.error('Group message notification failed', error));
    if (!isXhr(req)) return res.redirect(fallback);
    const shaped = { ...message.toObject(), sender: { _id: userId, name: req.session.user.name, profilePicture: req.session.user.profilePicture } };
    const [item] = await renderMessages(res, [shaped], { group: true, viewerId: userId, groupId: String(group._id), reportBaseUrl: `/groups/${group._id}` });
    res.json({ ok: true, message: item, clientId: req.body.clientId || null });
  } catch (error) {
    logger.error('Sending group message failed', error);
    sendFailure(req, res, 500, 'That message could not be sent.', fallback);
  }
};

exports.groupAttachment = async (req, res) => {
  try {
    if (!isObjectId(req.params.id) || !isObjectId(req.params.messageId)) return res.status(404).end();
    const group = await GroupConversation.findById(req.params.id).select('members').lean();
    if (!memberOf(group, req.session.user.id)) return res.status(404).end();
    const message = await GroupMessage.findOne({ _id: req.params.messageId, group: group._id }).select('attachment').lean();
    return sendMessageAttachment(res, message, req);
  } catch (error) {
    logger.error('Loading group attachment failed', error);
    return res.status(404).end();
  }
};

exports.groupReportMessage = async (req, res) => {
  const fallback = `/groups/${req.params.id}`;
  try {
    const reason = String(req.body.reason || '').trim().slice(0, 500);
    if (!reason) { req.session.flash = { type: 'error', message: 'Choose a reason to report this message.' }; return res.redirect(fallback); }
    if (!isObjectId(req.params.id) || !isObjectId(req.params.messageId)) return res.redirect('/groups');
    const group = await GroupConversation.findById(req.params.id).select('members').lean();
    const userId = req.session.user.id;
    if (!memberOf(group, userId)) return res.redirect('/groups');
    const message = await GroupMessage.findOne({ _id: req.params.messageId, group: group._id }).select('sender body attachment.filename').populate('sender', 'name').lean();
    if (!message || String(message.sender?._id || message.sender) === String(userId)) return res.redirect(fallback);
    const contextText = `${message.sender?.name || 'Member'}: ${message.body || `[attachment: ${message.attachment?.filename || 'file'}]`}`.slice(0, 3000);
    await Report.updateOne({ reporter: userId, targetType: 'group-message', target: message._id }, {
      $setOnInsert: { reporter: userId, targetType: 'group-message', target: message._id, reason, contextText }
    }, { upsert: true });
    req.session.flash = { type: 'success', message: 'Message reported to the moderation team.' };
    res.redirect(fallback);
  } catch (error) {
    logger.error('Reporting group message failed', error);
    req.session.flash = { type: 'error', message: 'Could not report that message.' };
    res.redirect(fallback);
  }
};

exports.groupReact = async (req, res) => {
  try {
    const userId = req.session.user.id;
    const group = await GroupConversation.findById(req.params.id).select('members').lean();
    if (!memberOf(group, userId)) return res.status(404).json({ ok: false, error: 'Message not found.' });
    const message = await GroupMessage.findOne({ _id: req.params.messageId, group: req.params.id });
    if (!message) return res.status(404).json({ ok: false, error: 'Message not found.' });
    const result = toggleReaction(message.reactions.map((entry) => entry.toObject()), req.body.emoji, userId);
    if (!result) return res.status(400).json({ ok: false, error: 'Unsupported reaction.' });
    message.set('reactions', result.reactions);
    await message.save();
    res.json({ ok: true, reactions: result.summary });
  } catch (error) {
    logger.error('Reacting to a group message failed', error);
    res.status(500).json({ ok: false, error: 'Could not react to that message.' });
  }
};

exports.notifyMessage = notifyMessage;
exports.memberOf = memberOf;
exports.previewText = previewText;
