const User = require('../models/User');
const Notification = require('../models/Notification');
const { sendPushToUser } = require('./push');
const logger = require('./logger');
const { notificationPreferenceAllows } = require('../utils/notificationPreferences');

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

const CODE_LANGUAGE_ALIASES = {
  csharp: 'csharp', cs: 'csharp', cxx: 'cpp', cplusplus: 'cpp', htm: 'markup',
  html: 'markup', js: 'javascript', jsx: 'jsx', md: 'markdown', py: 'python',
  sh: 'bash', shell: 'bash', ts: 'typescript', tsx: 'tsx', xml: 'markup', yml: 'yaml'
};
const SUPPORTED_CODE_LANGUAGES = new Set([
  'bash', 'c', 'clike', 'cpp', 'csharp', 'css', 'diff', 'go', 'java', 'javascript',
  'json', 'jsx', 'markdown', 'markup', 'php', 'python', 'ruby', 'rust', 'sql',
  'typescript', 'tsx', 'yaml'
]);

function renderCodeBlock(code, language) {
  const normalized = String(language || '').toLowerCase().replace(/[^a-z0-9_+-]/g, '');
  const requestedLanguage = CODE_LANGUAGE_ALIASES[normalized] || normalized;
  const canonical = SUPPORTED_CODE_LANGUAGES.has(requestedLanguage) ? requestedLanguage : '';
  const languageClass = canonical ? ` class="language-${canonical}"` : '';
  const label = canonical || 'auto';
  const escapedCode = String(code).replace(/[&<>"']/g, (character) => HTML_ENTITIES[character]);
  return `<div class="code-block"><div class="code-block-header"><span data-code-language-label>${label === 'auto' ? 'Auto-detect' : label}</span><button class="code-copy-button" type="button" data-copy-code>Copy code</button><span class="code-copy-status" data-copy-status role="status" aria-live="polite"></span></div><pre><code${languageClass}>${escapedCode}</code></pre></div>`;
}

function extractFencedCode(text) {
  const blocks = [];
  const source = String(text).replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  const output = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opening = lines[index].match(/^ {0,3}```([^\s`]*)[^\n]*$/);
    if (!opening) {
      output.push(lines[index]);
      continue;
    }
    const codeLines = [];
    let end = index + 1;
    while (end < lines.length && !/^ {0,3}```\s*$/.test(lines[end])) {
      codeLines.push(lines[end]);
      end += 1;
    }
    if (end === lines.length) {
      output.push(...lines.slice(index));
      break;
    }
    let placeholder = `CROWdwIDE_CODE_BLOCK_${blocks.length}_END`;
    while (source.includes(placeholder)) placeholder += '_';
    blocks.push({ placeholder, html: renderCodeBlock(codeLines.join('\n'), opening[1]) });
    output.push('', placeholder, '');
    index = end;
  }
  return { text: output.join('\n'), blocks };
}

function renderRichBody(text = '') {
  const { text: withoutCode, blocks: codeBlocks } = extractFencedCode(text);
  const linked = renderMentions(withoutCode);
  const contentBlocks = linked.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
  if (!contentBlocks.length) return '';
  return contentBlocks.map((block) => {
    const codeBlock = codeBlocks.find((entry) => entry.placeholder === block);
    if (codeBlock) return codeBlock.html;
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
  const eligible = recipients.filter((user) => user && String(user._id) !== String(actorId) && notificationPreferenceAllows(user.notificationPreferences, 'comments', 'mention'));
  if (!eligible.length) return;
  await Notification.insertMany(eligible.map((user) => ({ recipient: user._id, actor: actorId, type: 'mention', message, post: postId, community: communityId })));
  await Promise.all(eligible.map((user) => sendPushToUser(user._id, {
    title: 'Crowdwide',
    body: message,
    url: postId ? `/posts/${postId}` : '/notifications'
  }).catch((error) => logger.error('Push notification failed', error))));
}

module.exports = { extractMentionHandles, notifyMentionedUsers, renderMentions, renderRichBody };
