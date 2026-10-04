// Renders the main templates with stub data so a broken template (bad include,
// undefined variable, ...) fails here instead of on a live page.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { icon } = require('../src/utils/icons');
const { renderMentions, renderRichBody } = require('../src/services/mentions');
const { sendMessageAttachment } = require('../src/controllers/chatController');
const Post = require('../src/models/Post');

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

  sendMessageAttachment(res, { attachment: { filename: 'photo.jpg', contentType: 'image/jpeg', size: 3, data: Buffer.from('abc') } });
  assert.match(res.headers['Content-Disposition'], /^inline;/);

  const pdfResponse = { headers: {}, set(headers) { Object.assign(this.headers, headers); }, send(data) { captures.push(data); }, status(code) { this.statusCode = code; return this; }, end() { captures.push('ended'); } };
  sendMessageAttachment(pdfResponse, { attachment: { filename: 'note.pdf', contentType: 'application/pdf', size: 123, data: Buffer.from('abc') } });
  assert.match(pdfResponse.headers['Content-Disposition'], /^attachment;/);

  const videoResponse = { headers: {}, set(headers, value) { if (typeof headers === 'string') this.headers[headers] = value; else Object.assign(this.headers, headers); }, send(data) { this.data = data; }, status(code) { this.statusCode = code; return this; }, end() { this.ended = true; } };
  sendMessageAttachment(videoResponse, { attachment: { filename: 'clip.mp4', contentType: 'video/mp4', size: 6, data: Buffer.from('abcdef') } }, { headers: { range: 'bytes=1-3' } });
  assert.equal(videoResponse.statusCode, 206);
  assert.equal(videoResponse.headers['Accept-Ranges'], 'bytes');
  assert.equal(videoResponse.headers['Content-Range'], 'bytes 1-3/6');
  assert.equal(videoResponse.headers['Content-Length'], '3');
  assert.equal(videoResponse.data.toString(), 'bcd');
});

test('search results clamp long text and use responsive result classes', async () => {
  const html = await render('pages/search.ejs', {
    title: 'Search', pagePath: '/search', noIndex: true, query: 'react hooks',
    filters: { type: '', community: '', sort: 'newest', from: '', to: '', media: '', unanswered: false },
    communityOptions: [], meilisearchEnabled: false, recentSearches: [], trendingHashtags: [],
    popularSearches: [], users: [{ _id: 'u2', name: 'Asha', bio: 'a'.repeat(180) }],
    communities: [{ _id: 'c1', slug: 'hooks', name: 'Hooks', membersCount: 3, description: 'b'.repeat(280) }],
    posts: [post(91, { body: 'c'.repeat(300) })]
  });
  assert.match(html, /class="explore-page search-page"/);
  assert.match(html, /class="person-bio search-result-description"/);
  assert.match(html, /class="search-result-description">3 members ·/);
  assert.match(html, /class="post-card search-result-post"/);
  assert.match(html, /class="post-body search-result-description"/);
  assert.doesNotMatch(html, /max-width:1080px|line-clamp:3;max-height:5em/);
});

test('community invite and sharing UI are rendered for private community owners', async () => {
  const html = await render('pages/community-owner.ejs', {
    title: 'Community controls', pagePath: '/communities/c1/manage', noIndex: true,
    community: { _id: 'c1', slug: 'sketch-club', name: 'Sketch Club', description: 'Draw together', owner: 'u1', membersCount: 1, members: [], moderators: [], joinRequests: [], pinnedPosts: [], hashtags: [], bannedWords: [], isPrivate: true },
    inviteUrl: 'https://x/communities/invite/secret',
    members: [], posts: [], pendingPosts: [], requests: [], moderators: [], quests: [], isOwner: true
  });
  assert.match(html, /Private community invite/);
  assert.match(html, /Anyone signed in to Crowdwide who opens this invite can join immediately/);
  assert.match(html, /data-share-invite/);
  assert.match(html, /Share on X/);
  assert.match(html, /communities\/c1\/invite\/revoke/);
});

test('community invite landing renders a join confirmation page', async () => {
  const html = await render('pages/community-invite.ejs', {
    title: 'Join Sketch Club', pagePath: '/communities/invite/token', noIndex: true,
    community: { name: 'Sketch Club', description: 'Draw together' },
    inviteJoinUrl: '/communities/invite/token/join'
  });
  assert.match(html, /Join community/);
  assert.match(html, /name="_csrf" value="tok"/);
  assert.match(html, /\/communities\/invite\/token\/join/);
});

test('chat-message renders text, GIF, shared post, unavailable post and system rows', async () => {
  const msg = (extra) => render('partials/chat-message.ejs', { group: true, viewerId: 'u1', reportBaseUrl: '/groups/g1', message: { _id: 'm1', sender: { _id: 'u2', name: 'Asha' }, createdAt: new Date(), body: '', ...extra } });
  const text = await msg({ body: '<b>hi</b>' });
  assert.match(text, /class="chat-msg"/);
  assert.match(text, /&lt;b&gt;hi&lt;\/b&gt;/, 'message text must be escaped');
  assert.match(text, /chat-sender/);
  assert.match(text, /aria-label="Report message"/);
  assert.match(text, /class="report-reason-field"/);
  assert.match(text, /Harassment or bullying/);
  const multiline = await msg({ body: 'Hi,\nhow are you?\nwassup' });
  assert.match(multiline, /Hi,\nhow are you\?\nwassup/);
  const own = await msg({ sender: { _id: 'u1', name: 'Me' }, body: 'yo' });
  assert.match(own, /chat-msg is-own/);
  assert.doesNotMatch(own, /chat-sender/);
  assert.doesNotMatch(own, /aria-label="Report message"/);
  const gif = await msg({ gif: { url: 'https://media.giphy.com/x.gif', width: 200, height: 100 } });
  assert.match(gif, /class="chat-gif"/);
  assert.match(gif, /is-media/);
  const imageAttachment = await msg({ attachment: { filename: 'photo.jpg', contentType: 'image/jpeg', size: 2048 } });
  assert.match(imageAttachment, /chat-attachment-media/);
  assert.match(imageAttachment, /<img class="chat-attachment-media"/);
  assert.match(imageAttachment, /src="\/groups\/g1\/messages\/m1\/attachment"/);
  assert.match(imageAttachment, /chat-bubble is-media/);
  const videoAttachment = await msg({ attachment: { filename: 'clip.mp4', contentType: 'video/mp4', size: 4096 } });
  assert.match(videoAttachment, /chat-attachment-media/);
  assert.match(videoAttachment, /<video class="chat-attachment-media"/);
  assert.match(videoAttachment, /src="\/groups\/g1\/messages\/m1\/attachment"/);
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
  assert.match(dm, /data-chat-search-toggle/);
  assert.match(dm, /data-chat-search-close/);
  assert.match(dm, /enctype="multipart\/form-data"/);
  assert.match(dm, /name="attachment"/);
  assert.match(dm, /aria-live="polite"/);
  const group = await render('pages/group-thread.ejs', { ...shared, title: 'G', group: { _id: 'g1', name: 'Crew', avatar: '', members: [{ _id: 'u1', name: 'Me' }, { _id: 'u2', name: 'Asha' }] } });
  assert.match(group, /data-kind="group"/);
  assert.match(group, /\/groups\/g1\/info/);
  assert.match(group, /data-message-search-form/);
  assert.match(group, /data-chat-search-toggle/);
  const noGifs = await render('pages/message-thread.ejs', { ...shared, title: 'DM', person: { _id: 'u2', name: 'Asha' }, gifsEnabled: false });
  assert.doesNotMatch(noGifs, /data-gif-trigger/, 'no GIF button when GIPHY_API_KEY is not set');
});

test('post cards render co-author credit when a post is collaborative', async () => {
  const html = await render('partials/post-card.ejs', {
    post: { ...post(1), author: { _id: 'u1', name: 'Me' }, coAuthors: [{ _id: 'u2', name: 'Priya' }, { _id: 'u3', name: 'Aadi' }], community: null, questTitle: 'Weekly sketch sprint', body: 'Collab post', likes: [], commentsCount: 0, sharesCount: 0, viewsCount: 0 },
    csrfToken: 'tok',
    currentUser: { id: 'u1', name: 'Me' }
  });
  assert.match(html, /with Priya/);
  assert.match(html, /Aadi/);
  assert.match(html, /Quest post/);
  assert.match(html, /Weekly sketch sprint/);
});

test('post page: flat actions, send-to-chat share, comment box, no Quote', async () => {
  const html = await render('pages/post-detail.ejs', {
    title: 'p', pagePath: '/posts/p1', comments: [{}],
    post: { ...post(1), body: 'Hi,\nhow are you?\nwassup', liked: true, bookmarked: false, poll: null, quotedPost: null, replyTo: null, questTitle: 'Weekly sketch sprint' },
    commentTree: [{ _id: 'c1', author: { _id: 'a2', name: 'B' }, body: 'hi', gif: { url: 'https://media.giphy.com/c.gif' }, createdAt: new Date(), likes: [], children: [] }]
  });
  assert.match(html, /data-share-open/);
  assert.doesNotMatch(html, /\/share"/, 'the old count-on-click share form is gone');
  assert.doesNotMatch(html, /\/quote/);
  assert.match(html, /Reply with a post/);
  assert.match(html, /id="comment-body"/);
  assert.match(html, /class="comment-gif"/);
  assert.match(html, /<p>Hi,<br>how are you\?<br>wassup<\/p>/);
  assert.match(html, /post-view-actions/);
  assert.match(html, /data-share-count-for="p1"/);
  assert.match(html, /Quest post · Weekly sketch sprint/);
  assert.match(html, /action="\/comments\/c1\/report"/);
  assert.match(html, /Choose a reason/);
});

test('post moderation controls render visibly for staff outside the collapsed more-options menu', async () => {
  const html = await render('pages/post-detail.ejs', {
    title: 'p', pagePath: '/posts/p1', comments: [],
    post: { ...post(1), liked: false, bookmarked: false, poll: null, quotedPost: null, replyTo: null },
    commentTree: [], postModerationRole: 'moderator',
    currentUser: { ...currentUser, role: 'moderator' }
  });
  const moderationAt = html.indexOf('class="post-moderation-tools"');
  const moreOptionsEnd = html.indexOf('</details>', html.indexOf('class="post-more"'));
  assert.ok(moderationAt > moreOptionsEnd, 'moderation controls must not be inside collapsed More options');
  assert.match(html, /Moderation options/);
  assert.match(html, /action="\/posts\/p1\/moderate"/);
  assert.match(html, /Send for approval/);
  const adminHtml = await render('pages/post-detail.ejs', {
    title: 'p', pagePath: '/posts/p1', comments: [],
    post: { ...post(1), liked: false, bookmarked: false, poll: null, quotedPost: null, replyTo: null },
    commentTree: [], postModerationRole: 'admin',
    currentUser: { ...currentUser, role: 'user' }
  });
  assert.match(adminHtml, /Apply action/, 'the fresh database role, not the session role, controls the action label');
});

test('group info: admins see management tools, plain members do not', async () => {
  const group = { _id: 'g1', name: 'Crew', description: '', avatar: '', creator: 'u1', members: [{ _id: 'u1', name: 'Me' }, { _id: 'u2', name: 'Asha' }] };
  const common = { title: 't', pagePath: '/x', noIndex: true, group, suggestions: [], maxMembers: 50, adminIds: new Set(['u1']), inviteUrl: 'https://x/groups/join/abc123abc123' };
  const admin = await render('pages/group-settings.ejs', { ...common, isAdmin: true, isOwner: true });
  for (const needle of ['/rename', '/avatar', '/members"', '/invite/revoke', '/members/u2/remove', '/members/u2/admin', '/leave', 'groups/join/abc123abc123']) assert.ok(admin.includes(needle), `admin view should include ${needle}`);
  const member = await render('pages/group-settings.ejs', { ...common, isAdmin: false, isOwner: false });
  for (const needle of ['/rename', '/avatar"', '/invite', '/remove']) assert.ok(!member.includes(needle), `member view should not include ${needle}`);
  assert.match(member, /\/leave/);
  assert.match(admin, /data-share-invite/);
  assert.match(admin, /Share on X/);
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
    communities: [], composerCommunities: [{ _id: 'c1', name: 'Sketch Club' }],
    availableQuests: [{ _id: 'q1', title: 'Weekly sketch sprint', community: { _id: 'c1', name: 'Sketch Club' } }],
    selectedQuestId: 'q1', selectedCommunityId: 'c1',
    people: [], joinedCommunities: [], following: []
  });
  assert.match(html, /data-share-open/);
  assert.match(html, /data-share-sheet/);
  assert.match(html, /feed-sentinel/);
  assert.doesNotMatch(html, /Ranked for you:/);
  assert.match(html, /composer-options/);
  assert.match(html, /Share with your community/);
  assert.doesNotMatch(html, /Account settings →/);
  assert.match(html, /name="quest"/);
  assert.match(html, /Weekly sketch sprint/);
  assert.doesNotMatch(html, /name="quest"[^>]*disabled/);
  assert.match(html, /value="c1" selected/);
  assert.match(html, /value="q1" data-community="c1" selected/);
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

test('landing page applies the member theme and renders real profile avatars', async () => {
  const html = await render('pages/home.ejs', {
    title: 'Home', pagePath: '/',
    currentUser: { ...currentUser, theme: 'pink' },
    stats: { members: 2, posts: 1, communities: 0, communitiesAreLive: true, topCommunities: [] },
    viralPosts: [{ author: { _id: 'u2', name: 'Nia', profilePicture: '/media/nia.webp' }, body: 'A bright idea', likesTotal: 3 }],
    popularPeople: [{ _id: 'u2', name: 'Nia', profilePicture: '/media/nia.webp', followers: 3 }]
  });

  assert.match(html, /data-theme="pink"/);
  assert.match(html, /avatar-stack/);
  assert.match(html, /src="\/media\/nia\.webp"/);
  assert.doesNotMatch(html, /style="color:#f6f6fa;/);
});

test('notification settings render grouped, accessible preferences', async () => {
  const html = await render('pages/settings.ejs', {
    title: 'Settings', pagePath: '/settings/notifications', section: 'notifications', noIndex: true,
    user: { _id: 'u1', name: 'Puneet', email: 'p@x.com', notificationPreferences: {} },
    sessions: [], ownedCommunities: [], blockedUsers: [], appeals: [], accountEvents: [],
    sessionID: 'session', pushConfigured: false
  });
  assert.match(html, /In-app notifications/);
  assert.match(html, /Email updates/);
  assert.match(html, /name="notifySecurity"/);
  assert.match(html, /name="commentNotifications"/);
  assert.match(html, /<option value="mentions"[^>]*>Only @mentions/);
  assert.match(html, /notification-option/);
});

test('profile editor exposes the 40-word bio limit', async () => {
  const html = await render('pages/settings.ejs', {
    title: 'Settings', pagePath: '/settings/profile', section: 'profile', noIndex: true,
    user: { _id: 'u1', name: 'Puneet', email: 'p@x.com', bio: 'Curious about design.', hashtags: [], links: [] },
    sessions: [], ownedCommunities: [], blockedUsers: [], appeals: [], accountEvents: [],
    sessionID: 'session'
  });
  assert.match(html, /data-word-limit="40"/);
  assert.match(html, /Bio · up to 40 words/);
});

test('community detail renders a quest board with member actions', async () => {
  const html = await render('pages/community-detail.ejs', {
    title: 'Design Lab', pagePath: '/communities/design-lab', noIndex: true,
    community: { _id: 'c1', slug: 'design-lab', name: 'Design Lab', category: 'design', description: 'Share ideas', hashtags: ['design'], membersCount: 12, isPrivate: false, owner: { _id: 'u1', name: 'Puneet' }, members: ['u1', 'u2'], moderators: [], pinnedPosts: [] },
    posts: [], members: [{ _id: 'u1', name: 'Puneet' }, { _id: 'u2', name: 'Asha' }],
    moderatorIds: ['u1'], joined: true, requested: false, isOwner: true, locked: false,
    quests: [
      { _id: 'q1', title: 'Ship a mockup', description: 'Post one visual concept this week.', reward: 'Community badge', participants: [{ _id: 'u2', name: 'Asha' }], completedBy: [], creator: { _id: 'u1', name: 'Puneet' } },
      { _id: 'q3', title: 'Share your process', participants: [{ _id: 'u1', name: 'Puneet' }], completedBy: [], creator: { _id: 'u1', name: 'Puneet' } }
    ]
  });
  assert.match(html, /Quest board/);
  assert.match(html, /Ship a mockup/);
  assert.match(html, /Join quest/);
  assert.match(html, /href="\/dashboard\?quest=q3"/);
});

test('community map gives users a usable fallback when map tile access is blocked', async () => {
  const html = await render('pages/community-map.ejs', {
    title: 'Community Galaxy', description: 'Map communities', pagePath: '/community-map', noIndex: true, includeLeaflet: true,
    mapApiKey: 'test-map-key',
    mapCommunities: [], categories: []
  });
  assert.match(html, /data-community-discovery-map/);
  assert.match(html, /data-map-tile-error/);
  assert.match(html, /You can still search and open communities from the list/);
  assert.match(html, /OpenStreetMap contributors/);
  assert.match(html, /Report a map issue/);
  assert.match(html, /community-map\.js\?v=4/);
  assert.match(html, /CARTO/);
  assert.match(html, /data-map-api-key="test-map-key"/);
  assert.match(html, /MapTiler/);
});

test('community owner location picker offers current location with permission status', async () => {
  const html = await render('pages/community-owner.ejs', {
    title: 'Community controls', pagePath: '/communities/c1/manage', noIndex: true,
    community: { _id: 'c1', slug: 'sketch-club', name: 'Sketch Club', description: 'Draw together', owner: 'u1', membersCount: 1, members: [], moderators: [], joinRequests: [], pinnedPosts: [], hashtags: [], bannedWords: [] },
    members: [], posts: [], pendingPosts: [], requests: [], moderators: [], quests: [], isOwner: true
  });
  assert.match(html, /data-use-current-location/);
  assert.match(html, /Use current location/);
  assert.match(html, /data-location-status/);
});

test('ended quests show the winner and reward state', async () => {
  const html = await render('pages/community-detail.ejs', {
    title: 'Design Lab', pagePath: '/communities/design-lab', noIndex: true,
    community: { _id: 'c1', slug: 'design-lab', name: 'Design Lab', category: 'design', description: 'Share ideas', hashtags: ['design'], membersCount: 12, isPrivate: false, owner: { _id: 'u1', name: 'Puneet' }, members: ['u1', 'u2'], moderators: [], pinnedPosts: [] },
    posts: [], members: [{ _id: 'u1', name: 'Puneet' }, { _id: 'u2', name: 'Asha' }],
    moderatorIds: ['u1'], joined: true, requested: false, isOwner: true, locked: false,
    quests: [{ _id: 'q2', title: 'Final sprint', description: 'Complete the sprint.', reward: 'Featured post', status: 'ended', winner: { _id: 'u2', name: 'Asha' }, rewarded: true, participants: [{ _id: 'u2', name: 'Asha' }], completedBy: [{ _id: 'u2', name: 'Asha' }], creator: { _id: 'u1', name: 'Puneet' } }]
  });
  assert.match(html, /Winner: Asha/);
  assert.match(html, /Reward sent/);
});

test('profiles show community roles and quest-winner achievements', async () => {
  const html = await render('pages/profile.ejs', {
    title: 'Asha on Crowdwide', pagePath: '/u/u2', noIndex: false,
    profileUser: { _id: 'u2', id: 'u2', name: 'Asha', email: 'asha@example.test', isVerified: false, bio: '', hashtags: [], links: [], profilePicture: '', bannerImage: '', profileViews: 0, createdAt: new Date() },
    isSelf: true, profileTab: 'posts', posts: [], profileLikes: [], savedPosts: [],
    profileComments: [], activity: [], suggestions: [], followersCount: 0, followingCount: 0,
    postCount: 0, profileStats: { totalLikes: 0, totalComments: 0, totalViews: 0, totalShares: 0 },
    memberCommunities: [{ _id: 'c1', name: 'Sketch Club', slug: 'sketch-club', isOwner: false }],
    questAchievements: [{ _id: 'q1', title: 'Weekly sketch sprint', achievementTag: 'Community Artist', community: { name: 'Sketch Club', slug: 'sketch-club' } }]
  });
  assert.match(html, /Sketch Club/);
  assert.match(html, /Member/);
  assert.match(html, /Community Artist/);
  assert.match(html, /Quest winner/);
});

test('post edit and reply render as separate full-page composition flows', async () => {
  const sourcePost = post(1, { _id: 'p1', author: { _id: 'u2', name: 'Asha' }, body: 'Original post text', community: { _id: 'c1', name: 'Sketch Club', slug: 'sketch-club' } });
  const edit = await render('pages/post-compose.ejs', {
    title: 'Edit post', pagePath: '/posts/p1/edit', editorMode: 'edit', post: sourcePost, sourcePost, wordLimit: 60
  });
  assert.match(edit, /action="\/posts\/p1\/edit"/);
  assert.match(edit, /<textarea[^>]*>Original post text<\/textarea>/);
  assert.match(edit, /data-word-limit="60"/);
  assert.match(edit, /data-word-count-remaining/);
  assert.match(edit, /3 words used · 57 left/);
  const reply = await render('pages/post-compose.ejs', {
    title: 'Reply with a post', pagePath: '/posts/p1/reply', editorMode: 'reply', post: null, sourcePost, wordLimit: 50
  });
  assert.match(reply, /action="\/posts\/p1\/reply"/);
  assert.match(reply, /Original post text/);
  assert.match(reply, /Reply with a post/);
  assert.match(reply, /name="media"/);
  assert.match(reply, /name="mediaAlt"/);
  assert.match(reply, /name="mediaCaption"/);
  assert.match(reply, /name="mediaTranscript"/);
  assert.match(reply, /name="contentWarning"/);
  assert.match(reply, /data-word-limit="50"/);
  assert.match(reply, /0 words used · 50 left/);
  assert.doesNotMatch(reply, /name="body"[^>]*maxlength="4000"/);
});

test('reply post schema uses a word limit instead of the generic character limit', () => {
  const longReply = new Post({ body: 'word '.repeat(1000), replyTo: '507f1f77bcf86cd799439011' });
  const regularPost = new Post({ body: 'x'.repeat(4001) });

  assert.equal(longReply.validateSync()?.errors?.body, undefined);
  assert.ok(regularPost.validateSync()?.errors?.body);
});

test('community workspace renders its create form and owned community controls', async () => {
  const html = await render('pages/my-communities.ejs', {
    title: 'Your communities', pagePath: '/communities/mine', noIndex: true,
    communities: [{ _id: 'c1', name: 'Sketch Club', slug: 'sketch-club', description: 'Draw together', category: 'art', membersCount: 12, isPrivate: false, avatarImage: '' }]
  });
  assert.match(html, /name="description"/);
  assert.match(html, /Sketch Club/);
  assert.match(html, /href="\/communities\/c1\/manage"/);
  assert.match(html, /12 members/);
});

test('personal recap renders activity totals and a monthly timeline', async () => {
  const html = await render('pages/activity-recap.ejs', {
    title: 'Your activity recap', pagePath: '/recap', noIndex: true,
    recap: {
      periodLabel: 'Oct 2025 – Sep 2026',
      totals: { posts: 8, comments: 12, shares: 3, communities: 2 },
      months: [{ label: 'Sep', fullLabel: 'September 2026', posts: 2, comments: 1, shares: 0, postsHeight: 100, commentsHeight: 50, sharesHeight: 0, topics: [{ tag: 'sketching', posts: 2 }] }],
      topPost: { body: 'A favorite post', type: 'post', createdAt: new Date('2026-09-10T00:00:00Z'), engagement: 7 },
      topComment: { body: 'A thoughtful reply', createdAt: new Date('2026-09-11T00:00:00Z'), interactions: 5, post: { _id: 'p1', body: 'A conversation prompt' } },
      topTopics: [{ tag: 'sketching', posts: 2 }, { tag: 'design', posts: 1 }]
    }
  });
  assert.match(html, /Oct 2025 – Sep 2026/);
  assert.match(html, /8/);
  assert.match(html, /12/);
  assert.match(html, /A favorite post/);
  assert.match(html, /A thoughtful reply/);
  assert.match(html, /Topics you shared most/);
  assert.match(html, /#sketching/);
  assert.match(html, /View conversation/);
  assert.match(html, /September/);
  assert.match(html, /In-app shares/);
  assert.match(html, /<strong>3<\/strong>/);
});

test('footers link to the new docs and help pages, and the GitHub link uses a real icon (not a stray glyph)', async () => {
  const footer = await render('partials/site-footer.ejs');
  assert.match(footer, /href="\/docs"/);
  assert.match(footer, /href="\/help"/);
  assert.doesNotMatch(footer, /aria-label="Crowdwide on GitHub">⌥/);
  assert.match(footer, /icon-github/);
});
