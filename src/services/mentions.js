const User = require('../models/User');
const Notification = require('../models/Notification');

const HANDLE_PATTERN = /@([a-z0-9][a-z0-9._-]{1,39})/gi;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractMentionHandles(text = '') {
  return Array.from(new Set(Array.from(String(text).matchAll(HANDLE_PATTERN), (match) => match[1].toLowerCase()))).slice(0, 15);
}

async function notifyMentionedUsers(text, actorId, postId, communityId, message = 'mentioned you in a post.') {
  const handles = extractMentionHandles(text);
  if (!handles.length) return;
  const recipients = await Promise.all(handles.map((handle) => User.findOne({ email: new RegExp(`^${escapeRegex(handle)}@`, 'i'), isVerified: true }).select('_id notificationPreferences').lean()));
  const notifications = recipients.filter((user) => user && String(user._id) !== String(actorId) && user.notificationPreferences?.comments !== false)
    .map((user) => ({ recipient: user._id, actor: actorId, type: 'mention', message, post: postId, community: communityId }));
  if (notifications.length) await Notification.insertMany(notifications);
}

module.exports = { extractMentionHandles, notifyMentionedUsers };
