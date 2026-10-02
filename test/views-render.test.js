// Renders the main templates with stub data so a broken template (bad include,
// undefined variable, ...) fails here instead of on a live page.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { icon } = require('../src/utils/icons');
const { renderMentions, renderRichBody } = require('../src/services/mentions');
const { sendMessageAttachment } = require('../src/controllers/chatController');

const views = path.join(__dirname, '..', 'src', 'views');
const currentUser = { id: 'u1', name: 'Puneet K', email: 'p@x.com', role: 'user', profilePicture: '' };
const base = { icon, renderMentions, renderRichBody, csrfToken: 'tok', flash: null, currentUser, appUrl: 'http://x', gifsEnabled: true };
const render = (file, data = {}) => ejs.renderFile(path.join(views, file), { ...base, ...data });
const post = (i, extra = {}) => ({ _id: `p${i}`, author: { _id: `a${i}`, name: `Author ${i}` }, body: `Hello #tag ${i}`, type: 'post', likes: [1, 2], commentsCount: 3, sharesCount: 4, viewsCount: 9, hashtags: ['tag'], community: null, createdAt: new Date(), status: 'published', reactions: {}, media: [], ...extra });

test('chat attachment responses render previewable media inline and keep downloads for files', () => {
  const captures = [];
  const res = {
    headers: {},
    set(headers) { Object.assign(this.headers, headers); },
    send(data) { captures.push(data); },
    status(code) { this.statusCode = code; return this; },
    end() { captures.push('ended'); }
  };

  sendMessageAttachment(res, { attachment: { filename: 'photo.jpg', contentType: 'image/jpeg', size: 123, data: Buffer.from('abc') } });
  assert.match(res.headers['Content-Disposition'], /^inline;/);

  const pdfResponse = { headers: {}, set(headers) { Object.assign(this.headers, headers); }, send(data) { captures.push(data); }, status(code) { this.statusCode = code; return this; }, end() { captures.push('ended'); } };
  sendMessageAttachment(pdfResponse, { attachment: { filename: 'note.pdf', contentType: 'application/pdf', size: 123, data: Buffer.from('abc') } });
  assert.match(pdfResponse.headers['Content-Disposition'], /^attachment;/);
});

test('chat-message renders text, GIF, shared post, unavailable post and system rows', async () => {
  const msg = (extra) => render('partials/chat-message.ejs', { group: true, viewerId: 'u1', reportBaseUrl: 'http://x', message: { _id: 'm1', sender: { _id: 'u2', name: 'Asha' }, createdAt: new Date(), body: '', ...extra } });
  const text = await msg({ body: '<b>hi</b>' });
  assert.match(text, /class="chat-msg"/);
  assert.match(text, /&lt;b&gt;hi&lt;\/b&gt;/, 'message text must be escaped');
  assert.match(text, /chat-sender/);
  const own = await msg({ sender: { _id: 'u1', name: 'Me' }, body: 'yo' });
  assert.match(own, /chat-msg is-own/);
  assert.doesNotMatch(own, /chat-sender/);
  const gif = await msg({ gif: { url: 'https://media.giphy.com/x.gif', width: 200, height: 100 } });
  assert.match(gif, /class="chat-gif"/);
  assert.match(gif, /is-media/);
  const imageAttachment = await msg({ attachment: { filename: 'photo.jpg', contentType: 'image/jpeg', size: 2048 } });
  assert.match(imageAttachment, /chat-attachment-media/);
  assert.match(imageAttachment, /<img class="chat-attachment-media"/);
  const videoAttachment = await msg({ attachment: { filename: 'clip.mp4', contentType: 'video/mp4', size: 4096 } });
  assert.match(videoAttachment, /chat-attachment-media/);
  assert.match(videoAttachment, /<video class="chat-attachment-media"/);
  const shared = await msg({ postPreview: { id: 'p1', label: 'Article', author: 'Ravi', excerpt: 'Short text', image: null } });
  assert.match(shared, /href="\/posts\/p1"/);
  const hidden = await msg({ postPreview: { unavailable: true } });
  assert.match(hidden, /isn't available/);
  const system = await msg({ kind: 'system', body: 'added Priya.' });
  assert.match(system, /chat-system/);
});

test('direct message and group pages render a chat panel with no full-page form reload markup', async () => {
  const shared = { messagesHtml: '<div class="chat-msg" data-id="1" data-time="2026-01-01T00:00:00.000Z"></div>', lastId: '1', hasMore: true, pagePath: '/x', noIndex: true };
  const dm = await render('pages/message-thread.ejs', { ...shared, title: 'DM', person: { _id: 'u2', name: 'Asha' } });
  assert.match(dm, /data-chat data-kind="dm"/);
  assert.match(dm, /data-chat-form/);
  assert.match(dm, /data-gif-trigger/);
  assert.match(dm, /data-chat-more/);
  assert.match(dm, /data-message-search-form/);
  assert.match(dm, /enctype="multipart\/form-data"/);
  assert.match(dm, /name="attachment"/);
  assert.match(dm, /aria-live="polite"/);
  const group = await render('pages/group-thread.ejs', { ...shared, title: 'G', group: { _id: 'g1', name: 'Crew', avatar: '', members: [{ _id: 'u1', name: 'Me' }, { _id: 'u2', name: 'Asha' }] } });
  assert.match(group, /data-kind="group"/);
  assert.match(group, /\/groups\/g1\/info/);
  assert.match(group, /data-message-search-form/);
  const noGifs = await render('pages/message-thread.ejs', { ...shared, title: 'DM', person: { _id: 'u2', name: 'Asha' }, gifsEnabled: false });
  assert.doesNotMatch(noGifs, /data-gif-trigger/, 'no GIF button when GIPHY_API_KEY is not set');
});

test('post cards render co-author credit when a post is collaborative', async () => {
  const html = await render('partials/post-card.ejs', {
    post: { ...post(1), author: { _id: 'u1', name: 'Me' }, coAuthors: [{ _id: 'u2', name: 'Priya' }, { _id: 'u3', name: 'Aadi' }], community: null, body: 'Collab post', likes: [], commentsCount: 0, sharesCount: 0, viewsCount: 0 },
    csrfToken: 'tok',
    currentUser: { id: 'u1', name: 'Me' }
  });
  assert.match(html, /with Priya/);
  assert.match(html, /Aadi/);
});

test('post page: flat actions, send-to-chat share, comment box, no Quote', async () => {
  const html = await render('pages/post-detail.ejs', {
    title: 'p', pagePath: '/posts/p1', comments: [{}],
    post: { ...post(1), liked: true, bookmarked: false, poll: null, quotedPost: null, replyTo: null },
    commentTree: [{ _id: 'c1', author: { _id: 'a2', name: 'B' }, body: 'hi', gif: { url: 'https://media.giphy.com/c.gif' }, createdAt: new Date(), likes: [], children: [] }]
  });
  assert.match(html, /data-share-open/);
  assert.doesNotMatch(html, /\/share"/, 'the old count-on-click share form is gone');
  assert.doesNotMatch(html, /\/quote/);
  assert.match(html, /Reply with a post/);
  assert.match(html, /id="comment-body"/);
  assert.match(html, /class="comment-gif"/);
  assert.match(html, /post-view-actions/);
  assert.match(html, /data-share-count-for="p1"/);
});

test('group info: admins see management tools, plain members do not', async () => {
  const group = { _id: 'g1', name: 'Crew', description: '', avatar: '', creator: 'u1', members: [{ _id: 'u1', name: 'Me' }, { _id: 'u2', name: 'Asha' }] };
  const common = { title: 't', pagePath: '/x', noIndex: true, group, suggestions: [], maxMembers: 50, adminIds: new Set(['u1']), inviteUrl: 'https://x/groups/join/abc123abc123' };
  const admin = await render('pages/group-settings.ejs', { ...common, isAdmin: true, isOwner: true });
  for (const needle of ['/rename', '/avatar', '/members"', '/invite/revoke', '/members/u2/remove', '/members/u2/admin', '/leave', 'groups/join/abc123abc123']) assert.ok(admin.includes(needle), `admin view should include ${needle}`);
  const member = await render('pages/group-settings.ejs', { ...common, isAdmin: false, isOwner: false });
  for (const needle of ['/rename', '/avatar"', '/invite', '/remove']) assert.ok(!member.includes(needle), `member view should not include ${needle}`);
  assert.match(member, /\/leave/);
});

test('share sheet and group join pages render', async () => {
  assert.match(await render('partials/share-sheet.ejs'), /data-share-send/);
  const join = await render('pages/group-join.ejs', { title: 'Join', pagePath: '/x', noIndex: true, code: 'abc', full: false, group: { _id: 'g1', name: 'Crew', avatar: '', description: '', members: [{ name: 'A' }] } });
  assert.match(join, /action="\/groups\/join\/abc"/);
});

test('dashboard still renders with the share button and share sheet in the footer', async () => {
  const html = await render('pages/dashboard.ejs', {
    title: 't', pagePath: '/dashboard', noIndex: true,
    feed: { posts: [post(1)], visiblePosts: [post(1)], hasMore: true, activeTab: 'for-you', note: 'n' },
    communities: [], people: [], joinedCommunities: [], following: []
  });
  assert.match(html, /data-share-open/);
  assert.match(html, /data-share-sheet/);
  assert.match(html, /feed-sentinel/);
});

test('docs page renders the API endpoints, and info pages cover help', async () => {
  const docs = await render('pages/docs.ejs', { title: 'Developer docs', pagePath: '/docs', description: 'API docs' });
  assert.match(docs, /\/api\/v1\/posts/);
  assert.match(docs, /rss\.xml/);
  assert.match(docs, /docs-table/);
  const help = await render('pages/info.ejs', {
    title: 'Help center', pagePath: '/help', description: 'Help center', heading: 'Answers, not tickets.',
    intro: 'Common questions.', sections: [['Why verify?', 'Because spam.']]
  });
  assert.match(help, /Answers, not tickets\./);
  assert.match(help, /Why verify\?/);
});

test('footers link to the new docs and help pages, and the GitHub link uses a real icon (not a stray glyph)', async () => {
  const footer = await render('partials/site-footer.ejs');
  assert.match(footer, /href="\/docs"/);
  assert.match(footer, /href="\/help"/);
  assert.doesNotMatch(footer, /aria-label="Crowdwide on GitHub">⌥/);
  assert.match(footer, /icon-github/);
});
