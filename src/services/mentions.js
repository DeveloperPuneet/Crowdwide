const User = require('../models/User');
const Notification = require('../models/Notification');
const { sendPushToUser } = require('./push');
const logger = require('./logger');

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

// Turns escaped, mention-linked plain text into structural HTML: blank-line-
// separated paragraphs, "# heading" lines, "- item" lists, and **bold**/
// *italic* inline emphasis. HTML entities are escaped BEFORE any of this
// markup is applied, so nothing the author typed can inject real tags -
// every tag in the output is one this function inserted itself.
function applyInlineFormatting(line) {
  return line
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
}

function renderRichBody(text = '') {
  const linked = renderMentions(text);
  const blocks = linked.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
  if (!blocks.length) return '';
  return blocks.map((block) => {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length && lines.every((line) => /^[-*]\s+/.test(line))) {
      return `<ul>${lines.map((line) => `<li>${applyInlineFormatting(line.replace(/^[-*]\s+/, ''))}</li>`).join('')}</ul>`;
    }
    const headingMatch = lines.length === 1 && lines[0].match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      const level = Math.min(headingMatch[1].length + 2, 4);
      return `<h${level}>${applyInlineFormatting(headingMatch[2])}</h${level}>`;
    }
    return `<p>${lines.map(applyInlineFormatting).join('<br>')}</p>`;
  }).join('');
}

async function notifyMentionedUsers(text, actorId, postId, communityId, message = 'mentioned you in a post.') {
  const handles = extractMentionHandles(text);
  if (!handles.length) return;
  const recipients = await Promise.all(handles.map((handle) => User.findOne({ email: new RegExp(`^${escapeRegex(handle)}@`, 'i'), isVerified: true }).select('_id notificationPreferences').lean()));
  const eligible = recipients.filter((user) => user && String(user._id) !== String(actorId) && user.notificationPreferences?.comments !== false);
  if (!eligible.length) return;
  await Notification.insertMany(eligible.map((user) => ({ recipient: user._id, actor: actorId, type: 'mention', message, post: postId, community: communityId })));
  await Promise.all(eligible.map((user) => sendPushToUser(user._id, {
    title: 'Crowdwide',
    body: message,
    url: postId ? `/posts/${postId}` : '/notifications'
  }).catch((error) => logger.error('Push notification failed', error))));
}

module.exports = { extractMentionHandles, notifyMentionedUsers, renderMentions, renderRichBody };
