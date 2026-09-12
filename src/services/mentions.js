const User = require('../models/User');
const Notification = require('../models/Notification');

const HANDLE_PATTERN = /@([a-z0-9][a-z0-9._-]{1,39})/gi;
const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractMentionHandles(text = '') {
  return Array.from(new Set(Array.from(String(text).matchAll(HANDLE_PATTERN), (match) => match[1].toLowerCase()))).slice(0, 15);
}

function renderMentions(text = '') {
  const escaped = String(text).replace(/[&<>"']/g, (character) => HTML_ENTITIES[character]);
  return escaped.replace(/(^|\s)(@[a-z0-9][a-z0-9._-]{1,39})/gi, (match, prefix, mention) => `${prefix}<a class="mention-link" href="/search?q=%40${mention.slice(1).toLowerCase()}">${mention}</a>`);
}

async function notifyMentionedUsers(text, actorId, postId, communityId, message = 'mentioned you in a post.') {
  const handles = extractMentionHandles(text);
  if (!handles.length) return;
  const recipients = await Promise.all(handles.map((handle) => User.findOne({ email: new RegExp(`^${escapeRegex(handle)}@`, 'i'), isVerified: true }).select('_id notificationPreferences').lean()));
  const notifications = recipients.filter((user) => user && String(user._id) !== String(actorId) && user.notificationPreferences?.comments !== false)
    .map((user) => ({ recipient: user._id, actor: actorId, type: 'mention', message, post: postId, community: communityId }));
  if (notifications.length) await Notification.insertMany(notifications);
}

module.exports = { extractMentionHandles, notifyMentionedUsers, renderMentions };
