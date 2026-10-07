// Renders the main templates with stub data so a broken template (bad include,
// undefined variable, ...) fails here instead of on a live page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { icon } = require('../src/utils/icons');
const { renderMentions, renderRichBody } = require('../src/services/mentions');
const { sendMessageAttachment } = require('../src/controllers/chatController');
const webController = require('../src/controllers/webController');
const Post = require('../src/models/Post');
const { COMMUNITY_CATEGORIES } = require('../src/utils/communityCategories');
const { TASK_LABELS } = require('../src/services/maintenance');

const views = path.join(__dirname, '..', 'src', 'views');
const currentUser = { id: 'u1', name: 'Puneet K', email: 'p@x.com', role: 'user', profilePicture: '' };
const base = { icon, renderMentions, renderRichBody, csrfToken: 'tok', flash: null, currentUser, appUrl: 'http://x', gifsEnabled: true, communityCategories: COMMUNITY_CATEGORIES, promotionOffer: null };
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
  assert.deepEqual(captures[0], Buffer.from('abc'));

  const binary = new (require('mongoose').mongo.BSON.Binary)(Buffer.from('image-bytes'));
  const binaryImageResponse = {
    headers: {},
    set(headers) { Object.assign(this.headers, headers); },
    send(data) { this.data = data; },
    status(code) { this.statusCode = code; return this; },
    end() { this.ended = true; }
  };
  sendMessageAttachment(binaryImageResponse, { attachment: { filename: 'photo.jpg', contentType: 'image/jpeg', data: binary } });
  assert.equal(binaryImageResponse.data.toString(), 'image-bytes');
  assert.equal(binaryImageResponse.headers['Content-Length'], '11');

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
    popularSearches: [], users: [{ _id: 'u2', name: 'Asha', bio: 'a'.repeat(180), profilePicture: '/uploads/asha.png' }],
    communities: [{ _id: 'c1', slug: 'hooks', name: 'Hooks', avatarImage: '/uploads/hooks.png', membersCount: 3, description: 'b'.repeat(280) }],
    posts: [post(91, { body: 'c'.repeat(300) })]
  });
  assert.match(html, /class="explore-page search-page"/);
  assert.match(html, /class="search-filter-toggles">[\s\S]*name="media"[\s\S]*name="unanswered"/);
  assert.match(html, /class="avatar small has-image"><span class="avatar-initial"[^>]*>A<\/span><img class="avatar-image" src="\/uploads\/asha\.png"/);
  assert.match(html, /class="person-bio search-result-description" data-bio-limit/);
  assert.match(html, /class="search-result-description">3 members ·/);
  assert.match(html, /class="community-glyph search-community-glyph">[\s\S]*class="search-community-avatar" src="\/uploads\/hooks\.png" alt="" aria-hidden="true"/);
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
  assert.match(html, /Private communities cannot be promoted/);
});

test('public community owner can purchase a Waves promotion and see its status', async () => {
  const offer = { wavesCost: 50, durationHours: 48 };
  const common = {
    title: 'Community controls', pagePath: '/communities/c1/manage', noIndex: true,
    communityPromotionOffer: offer,
    community: {
      _id: 'c1', slug: 'sketch-club', name: 'Sketch Club', description: 'Draw together',
      owner: 'u1', membersCount: 8, members: [], moderators: [], joinRequests: [],
      pinnedPosts: [], hashtags: [], bannedWords: [], isPrivate: false
    },
    inviteUrl: '', members: [], posts: [], pendingPosts: [], requests: [],
    moderators: [], quests: [], isOwner: true
  };
  const ready = await render('pages/community-owner.ejs', common);
  assert.match(ready, /Place your public community/);
  assert.match(ready, /50 Waves/);
  assert.match(ready, /action="\/communities\/c1\/promote"/);
  assert.match(ready, /name="_csrf" value="tok"/);

  const active = await render('pages/community-owner.ejs', {
    ...common,
    community: {
      ...common.community,
      promotionStatus: 'active',
      promotionWavesCost: 50,
      promotionUntil: new Date(Date.now() + 60 * 60 * 1000)
    }
  });
  assert.match(active, /Promoted · paid with 50 Waves/);
  assert.match(active, /eligible for labeled promoted placements/);
  assert.doesNotMatch(active, /Promote with Waves/);
});

test('advertiser dashboard renders application form and campaign metrics', async () => {
  const html = await render('pages/advertising-dashboard.ejs', {
    title: 'Advertising dashboard', pagePath: '/advertising', noIndex: true,
    advertiser: {
      _id: 'a1', user: 'u1', businessName: 'Example Co', status: 'approved', isVerified: true,
      moderationHistory: [{ status: 'approved', reason: 'Verified.', actor: { name: 'Admin A' }, createdAt: new Date() }]
    },
    advertisingTermsVersion: '2026-10-07',
    advertisingTermsAccepted: true,
    campaigns: [{
      _id: 'campaign-1', title: 'Launch', status: 'approved', fundingStatus: 'funded',
      impressions: 100, clicks: 5, ctr: 5, wavesSpent: 2, remainingBudget: 18,
      totalBudget: 20, description: 'Campaign description',
      moderationHistory: [{ status: 'approved', reason: 'Approved.', actor: { name: 'Admin B' }, createdAt: new Date() }]
    }],
    communities: [],
    sitewideFallbackAvailable: true,
    campaignAnalytics: {
      byCommunity: [{ campaignId: 'campaign-1', communityName: 'Public Community', impressions: 40, clicks: 2, ctr: 5 }],
      daily: [{ campaignId: 'campaign-1', date: '2026-10-06', impressions: 10, clicks: 1, ctr: 10 }]
    },
    totals: { impressions: 100, clicks: 5, ctr: 5, wavesSpent: 2, remainingBudget: 18 }
  });
  assert.match(html, /Advertising dashboard/);
  assert.match(html, /performance totals/);
  assert.match(html, /5% CTR/);
  assert.match(html, /Your campaigns/);
  assert.match(html, /Advertiser review history/);
  assert.match(html, /Campaign review history/);
  assert.match(html, /Performance by community and date/);
  assert.match(html, /Show this ad in the normal Crowdwide feed while no public community is monetized/);
  assert.match(html, /communities reached by a recorded impression or click/);
  assert.match(html, /Public Community<\/strong> · 40 impressions · 2 clicks · 5% CTR/);
  assert.match(html, /Daily activity · last 30 days/);
  assert.match(html, /2026-10-06<\/strong> · 10 impressions · 1 click · 10% CTR/);
  assert.match(html, /Admin A/);
  assert.match(html, /Admin B/);
  assert.match(html, /href="\/advertising\/terms"/);
  assert.match(html, /Fund and submit|Activate/);
});

test('advertising application requires acknowledgement of the linked Advertising Terms', async () => {
  const html = await render('pages/advertising-dashboard.ejs', {
    title: 'Advertising dashboard', pagePath: '/advertising', noIndex: true,
    advertiser: null, campaigns: [], communities: [],
    advertisingTermsVersion: '2026-10-07', advertisingTermsAccepted: false,
    totals: { impressions: 0, clicks: 0, ctr: 0, wavesSpent: 0, remainingBudget: 0 }
  });
  assert.match(html, /name="acceptAdvertisingTerms" required/);
  assert.match(html, /href="\/advertising\/terms"/);
});

test('rejected advertiser sees an appeal form and pending appeals replace it with status', async () => {
  const baseData = {
    title: 'Advertising dashboard', pagePath: '/advertising', noIndex: true,
    advertiser: { _id: 'a1', businessName: 'Example Co', status: 'rejected', rejectionReason: 'More information needed' },
    campaigns: [], communities: [], advertisingTermsVersion: '2026-10-07',
    advertisingTermsAccepted: true,
    totals: { impressions: 0, clicks: 0, ctr: 0, wavesSpent: 0, remainingBudget: 0 }
  };
  const appealForm = await render('pages/advertising-dashboard.ejs', { ...baseData, advertiserAppeal: null });
  assert.match(appealForm, /action="\/advertising\/appeal"/);
  assert.match(appealForm, /name="message"/);

  const pending = await render('pages/advertising-dashboard.ejs', {
    ...baseData, advertiserAppeal: { createdAt: new Date() }
  });
  assert.match(pending, /appeal is pending admin review/);
  assert.doesNotMatch(pending, /action="\/advertising\/appeal"/);
});

test('moderator console exposes advertiser screening and final admin review context', async () => {
  const html = await render('pages/moderator.ejs', {
    title: 'Moderator console', pagePath: '/moderator', noIndex: true,
    moderator: { moderatorId: 'MOD-1' }, reviewThreshold: 2, reportedOnly: false,
    reports: [], actions: [], communities: [], moderationFeed: [], pendingAppeals: [],
    pendingCampaigns: [],
    pendingAdvertisers: [{
      _id: 'advertiser-1', businessName: 'Example Co', user: { name: 'Asha' },
      website: 'https://example.test', notes: 'Local maker',
      termsVersion: '2026-10-07', termsAcceptedAt: new Date(),
      moderationHistory: [{ status: 'pending', reason: 'Application submitted.', actor: { name: 'Asha' }, createdAt: new Date() }]
    }],
    myOpenReportRecommendations: new Set()
  });

  test('moderator campaign review exposes prohibited-ad policy checks and flag categories', async () => {
    const html = await render('pages/moderator.ejs', {
      title: 'Moderator console', pagePath: '/moderator', noIndex: true,
      moderator: { moderatorId: 'MOD-1' }, reviewThreshold: 2, reportedOnly: false,
      reports: [], actions: [], communities: [], moderationFeed: [], pendingAppeals: [],
      pendingAdvertisers: [],
      pendingCampaigns: [{
        _id: 'campaign-policy', title: 'Campaign', description: 'Campaign text',
        totalBudget: 100, targetCommunities: [],
        advertiser: { businessName: 'Example Co', user: { name: 'Asha' } },
        moderationHistory: [{ status: 'submitted', reason: 'Budget funded.', actor: { name: 'Asha' }, createdAt: new Date() }]
      }],
      myOpenReportRecommendations: new Set()
    });
    assert.match(html, /Not for adult-only \(18\+\) products or services/);
    assert.match(html, /No erotic or sexually explicit content/);
    assert.match(html, /No gambling or betting/);
    assert.match(html, /No pornography/);
    assert.match(html, /No other inappropriate products or services/);
    assert.match(html, /name="flaggedCategory"/);
    assert.match(html, /Budget funded/);
  });
  assert.match(html, /Advertiser applications/);
  assert.match(html, /action="\/moderator\/advertisers\/advertiser-1\/review"/);
  assert.match(html, /Clear for admin/);
  assert.match(html, /Flag for admin/);
  assert.match(html, /Advertising Terms/);
  assert.match(html, /Advertiser review history/);
  assert.match(html, /Application submitted/);
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

test('private community request page shows a request action or its pending state', async () => {
  const community = { _id: 'c1', name: 'Secret Club', description: 'A private place' };
  const requestPage = await render('pages/community-request.ejs', {
    title: 'Request to join Secret Club', pagePath: '/communities/secret-club', noIndex: true,
    community, requested: false
  });
  assert.match(requestPage, /Request to join Secret Club/);
  assert.match(requestPage, /action="\/communities\/c1\/join"/);
  const pendingPage = await render('pages/community-request.ejs', {
    title: 'Request to join Secret Club', pagePath: '/communities/secret-club', noIndex: true,
    community, requested: true
  });
  assert.match(pendingPage, /Your request is pending moderator approval/);
  assert.match(pendingPage, /action="\/communities\/c1\/join-request\/cancel"/);
  assert.match(pendingPage, /community-request-status/);
  assert.doesNotMatch(pendingPage, /action="\/communities\/c1\/join"/);
});

test('chat-message renders text, GIF, shared post, unavailable post and system rows', async () => {
  const msg = (extra) => render('partials/chat-message.ejs', { group: true, viewerId: 'u1', reportBaseUrl: '/groups/g1', message: { _id: 'm1', sender: { _id: 'u2', name: 'Asha' }, createdAt: new Date(), body: '', ...extra } });
  const dmMsg = (extra) => render('partials/chat-message.ejs', { group: false, viewerId: 'u1', reportBaseUrl: '/messages/u2', message: { _id: 'm2', sender: { _id: 'u2', name: 'Asha' }, createdAt: new Date(), body: '', ...extra } });
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
  assert.match(own, /data-reply-message/);
  assert.match(own, /data-chat-select-message/);
  assert.doesNotMatch(own, /chat-sender/);
  assert.doesNotMatch(own, /aria-label="Report message"/);
  const reply = await msg({ body: 'Agreed', replyTo: { _id: 'parent-id', body: 'Original note', sender: { name: 'Asha' } } });
  assert.match(reply, /data-reply-jump="parent-id"/);
  assert.match(reply, /Original note/);
  const gif = await msg({ gif: { url: 'https://media.giphy.com/x.gif', width: 200, height: 100 } });
  assert.match(gif, /class="chat-gif"/);
  assert.match(gif, /data-media-viewer data-media-src="https:\/\/media\.giphy\.com\/x\.gif"/);
  assert.match(gif, /is-media/);
  const imageAttachment = await msg({ attachment: { filename: 'photo.jpg', contentType: 'image/jpeg', size: 2048 } });
  assert.match(imageAttachment, /chat-attachment-media/);
  assert.match(imageAttachment, /<img class="chat-attachment-media" src="\/groups\/g1\/messages\/m1\/attachment" data-media-viewer data-media-src="\/groups\/g1\/messages\/m1\/attachment"/);
  assert.match(imageAttachment, /src="\/groups\/g1\/messages\/m1\/attachment"/);
  assert.doesNotMatch(imageAttachment, /chat-attachment-media-link|download><img class="chat-attachment-media"/);
  assert.match(imageAttachment, /chat-bubble is-media/);
  const dmImageAttachment = await dmMsg({ attachment: { filename: 'photo.jpg', contentType: 'image/jpeg', size: 2048 } });
  assert.match(dmImageAttachment, /data-media-viewer data-media-src="\/messages\/u2\/m2\/attachment"/);
  const videoAttachment = await msg({ attachment: { filename: 'clip.mp4', contentType: 'video/mp4', size: 4096 } });
  assert.match(videoAttachment, /chat-attachment-media/);
  assert.match(videoAttachment, /<video class="chat-attachment-media"/);
  assert.match(videoAttachment, /data-media-viewer-trigger aria-label="View video larger"/);
  assert.match(videoAttachment, /class="chat-attachment-media-wrap media-viewer-trigger-wrap"/);
  assert.match(videoAttachment, /src="\/groups\/g1\/messages\/m1\/attachment"/);
  const dmVideoAttachment = await dmMsg({ attachment: { filename: 'clip.mp4', contentType: 'video/mp4', size: 4096 } });
  assert.match(dmVideoAttachment, /data-media-viewer-trigger aria-label="View video larger"/);
  assert.match(dmVideoAttachment, /src="\/messages\/u2\/m2\/attachment"/);
  const shared = await msg({ postPreview: { id: 'p1', label: 'Article', author: 'Ravi', excerpt: 'Short text', image: '/media/photo.jpg' } });
  assert.match(shared, /<a class="chat-post" href="\/posts\/p1">[\s\S]*<img src="\/media\/photo.jpg" data-media-viewer data-media-src="\/media\/photo.jpg"[\s\S]*<\/a>/);
  const sharedVideo = await msg({ postPreview: { id: 'p2', label: 'Post', author: 'Ravi', excerpt: 'Video', image: null, video: { url: '/media/clip', poster: '/media/poster' } } });
  assert.match(sharedVideo, /<video class="chat-post-video" controls preload="metadata" playsinline data-media-src="\/media\/clip" src="\/media\/clip" poster="\/media\/poster"><\/video>/);
  assert.match(sharedVideo, /data-media-viewer-trigger aria-label="View shared video larger"/);
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

test('post owners can buy a clearly labeled Waves promotion', async () => {
  const html = await render('pages/post-detail.ejs', {
    title: 'p', pagePath: '/posts/p1', comments: [], promotionOffer: { wavesCost: 25, durationHours: 24 },
    post: {
      ...post(1, { author: { _id: 'u1', name: 'Me' }, moderationStatus: 'good' }),
      liked: false, bookmarked: false, poll: null, quotedPost: null, replyTo: null
    },
    commentTree: []
  });
  assert.match(html, /Promote with Waves/);
  assert.match(html, /Promoted posts are labeled/);
  assert.match(html, /25 Waves/);
  assert.match(html, /action="\/posts\/p1\/promote"/);
  assert.match(html, /name="_csrf" value="tok"/);

  const activeHtml = await render('pages/post-detail.ejs', {
    title: 'p', pagePath: '/posts/p1', comments: [], promotionOffer: { wavesCost: 25, durationHours: 24 },
    post: {
      ...post(1, { author: { _id: 'u1', name: 'Me' }, moderationStatus: 'good', boostStatus: 'active', boostWavesCost: 25, boostUntil: new Date(Date.now() + 3600000) }),
      liked: false, bookmarked: false, poll: null, quotedPost: null, replyTo: null
    },
    commentTree: []
  });
  assert.match(activeHtml, /Promoted/);
  assert.match(activeHtml, /Paid with 25 Waves/);
  assert.doesNotMatch(activeHtml, /Promote with Waves/);
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
    sitewideFeedAds: [{
      afterPost: 1,
      contextType: 'sitewide',
      eventToken: '12345678-1234-4123-8123-123456789abc',
      campaign: {
        _id: 'campaign-global', title: 'A normal-feed advertisement', description: 'Campaign text',
        destinationUrl: 'https://example.test/landing',
        advertiser: { businessName: 'Example Ltd' }
      }
    }],
    communities: [{ _id: 'c1', name: 'Sketch Club', slug: 'sketch-club', avatarImage: '/uploads/sketch.png' }], communityCategories: COMMUNITY_CATEGORIES, composerCommunities: [{ _id: 'c1', name: 'Sketch Club' }],
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
  assert.match(html, /Crowdwide feed sponsorship/);
  assert.match(html, /data-context-type="sitewide"/);
  assert.match(html, /click\?context=sitewide&amp;event=/);
  assert.match(html, /deliveryContext: 'sitewide'/);
  assert.match(html, /Weekly sketch sprint/);
  assert.doesNotMatch(html, /name="quest"[^>]*disabled/);
  assert.match(html, /value="c1" selected/);
  assert.match(html, /value="q1" data-community="c1" selected/);
  assert.match(html, /src="\/uploads\/sketch\.png" alt="" class="community-card-avatar-image"/);
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

test('Waves and community monetization terms disclose platform-currency and payout limits', async () => {
  for (const [pagePath, expected] of [
    ['/waves/terms', /not money, cryptocurrency, stored value/],
    ['/community-monetization/terms', /Revenue and payouts are not available/]
  ]) {
    let page;
    await webController.infoPage({ path: pagePath }, {
      render(view, data) {
        page = { view, data };
      }
    });
    assert.equal(page.view, 'pages/info');
    const html = await render('pages/info.ejs', page.data);
    assert.match(html, expected);
    if (pagePath === '/waves/terms') {
      assert.match(html, /Post promotions/);
      assert.match(html, /Community promotions/);
      assert.match(html, /Promoted · paid with Waves/);
      assert.doesNotMatch(html, /No unlaunched premium, ad-free, post-promotion/);
    }
  }
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
  assert.doesNotMatch(html, /action="\/communities\/c1\/leave"/, 'the owner must retain community ownership');
});

test('community advertisement card provides a tracked visit and report action', async () => {
  const html = await render('partials/community-ad.ejs', {
    community: { _id: 'community-1' },
    ad: {
      eventToken: '12345678-1234-4123-8123-123456789abc',
      campaign: {
        _id: 'campaign-1', title: 'A useful product', description: 'Learn more about this service.',
        advertiser: { businessName: 'Example Ltd', website: 'https://example.test' }
      }
    }
  });
  assert.match(html, /Sponsored/);
  assert.match(html, /Learn more/);
  assert.match(html, /\/ads\/campaign-1\/click\?community=community-1&amp;event=/);
  assert.match(html, /action="\/ads\/campaign-1\/report"/);
  assert.match(html, /name="reason"/);
});

test('community detail places ads after the configured feed interval and in the sidebar', async () => {
  const html = await render('pages/community-detail.ejs', {
    title: 'Design Lab', pagePath: '/communities/design-lab', noIndex: true,
    community: { _id: 'c1', slug: 'design-lab', name: 'Design Lab', description: 'Share ideas', hashtags: [], membersCount: 1, isPrivate: false, owner: { _id: 'u1', name: 'Puneet' }, members: ['u1'], moderators: [], pinnedPosts: [] },
    posts: [post(1)], members: [], moderatorIds: [], joined: true, requested: false, isOwner: false, locked: false, quests: [],
    feedAds: [{
      afterPost: 1, eventToken: '12345678-1234-4123-8123-123456789abc',
      campaign: { _id: 'campaign-1', title: 'Design tools', description: 'Try these tools.', advertiser: { businessName: 'Example Ltd', website: 'https://example.test' } }
    }],
    sidebarAds: [{
      eventToken: '12345678-1234-4123-8123-123456789def',
      campaign: { _id: 'campaign-2', title: 'A second sponsor', advertiser: { businessName: 'Other Ltd' } }
    }]
  });
  assert.match(html, /Sponsored/);
  assert.match(html, /Design tools/);
  assert.match(html, /A second sponsor/);
  assert.match(html, /data-community-ad/);
  assert.match(html, /data-campaign-id="campaign-1"/);
  assert.match(html, /\/impression/);
  assert.match(html, /x-csrf-token/);
  assert.match(html, /Report this ad/);
});

test('joined community detail renders a leave action and focused community styling', async () => {
  const guidelines = 'Share your journey\nPost your progress';
  const html = await render('pages/community-detail.ejs', {
    title: 'Design Lab', pagePath: '/communities/design-lab', noIndex: true,
    community: { _id: 'c1', slug: 'design-lab', name: 'Design Lab', category: 'design', description: 'Share ideas', guidelines, hashtags: [], membersCount: 12, isPrivate: false, owner: { _id: 'owner', name: 'Owner' }, members: ['u1'], moderators: [], pinnedPosts: [] },
    posts: [], members: [], moderatorIds: [], joined: true, requested: false, isOwner: false, locked: false, quests: []
  });
  assert.match(html, /action="\/communities\/c1\/leave"/);
  assert.match(html, /class="community-glyph community-detail-avatar">D<\/span>/);
  assert.ok(html.includes(`<p class="community-guidelines-copy">${guidelines}</p>`));
  assert.match(html, /community-detail-layout/);
  assert.match(html, /href="\/css\/community-workspace\.css"/);
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
  const joinedAt = new Date('2021-04-15T18:30:00.000Z');
  const html = await render('pages/profile.ejs', {
    title: 'Asha on Crowdwide', pagePath: '/u/u2', noIndex: false,
    profileUser: { _id: 'u2', id: 'u2', name: 'Asha', email: 'asha@example.test', isVerified: false, bio: 'A full profile biography with more than twelve words should remain visible in its entirety.', hashtags: [], links: [], profilePicture: '', bannerImage: '', profileViews: 0, wavesBalance: 123.5, createdAt: joinedAt },
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
  assert.match(html, /Joined <time data-profile-joined-date datetime="2021-04-15T18:30:00\.000Z">[^<]+<\/time>/);
  assert.match(html, /123\.5<\/strong> Waves/);
  assert.match(html, /data-profile-anniversary data-joined-at="2021-04-15T18:30:00\.000Z"/);
  assert.match(html, /Happy Crowdwide anniversary!/);
  assert.match(html, /src="\/js\/profile-anniversary\.js"/);
  assert.match(html, /class="profile-bio person-bio">A full profile biography with more than twelve words should remain visible in its entirety\.<\/p>/);
  assert.doesNotMatch(html, /class="profile-bio person-bio" data-bio-limit/);
});

test('post edit and reply render as separate full-page composition flows', async () => {
  const sourcePost = post(1, { _id: 'p1', author: { _id: 'u2', name: 'Asha' }, body: 'Original post text', community: { _id: 'c1', name: 'Sketch Club', slug: 'sketch-club' } });
  const edit = await render('pages/post-compose.ejs', {
    title: 'Edit post', pagePath: '/posts/p1/edit', editorMode: 'edit', post: sourcePost, sourcePost, wordLimit: 60
  });
  assert.match(edit, /action="\/posts\/p1\/edit"/);
  assert.match(edit, /<form class="post-compose-form" method="post" action="\/posts\/p1\/edit"/);
  assert.match(edit, /<textarea[^>]*>Original post text<\/textarea>/);
  assert.match(edit, /data-word-limit="60"/);
  assert.match(edit, /data-word-count-remaining/);
  assert.match(edit, /3 words used · 57 left/);
  const reply = await render('pages/post-compose.ejs', {
    title: 'Reply with a post', pagePath: '/posts/p1/reply', editorMode: 'reply', post: null, sourcePost, wordLimit: 50
  });
  assert.match(reply, /action="\/posts\/p1\/reply"/);
  assert.match(reply, /<form class="post-compose-form" method="post" enctype="multipart\/form-data" action="\/posts\/p1\/reply"/);
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
    communityCategories: COMMUNITY_CATEGORIES,
    communities: [{ _id: 'c1', name: 'Sketch Club', slug: 'sketch-club', description: 'Draw together', category: 'art', membersCount: 12, isPrivate: false, avatarImage: '' }]
  });
  assert.match(html, /name="description"/);
  assert.match(html, /<select name="category"/);
  assert.match(html, /value="technology">Technology/);
  assert.match(html, /Sketch Club/);
  assert.match(html, /href="\/communities\/c1\/manage"/);
  assert.match(html, /12 members/);
});

test('Explore community cards render uploaded community logos', async () => {
  const html = await render('pages/explore.ejs', {
    title: 'Explore', pagePath: '/explore', noIndex: true,
    query: '', category: '', categories: [], isBrowsing: true,
    communities: [{
      _id: 'c1', slug: 'sketch-club', name: 'Sketch Club', description: 'Draw together',
      avatarImage: '/uploads/community.png', category: 'arts & crafts',
      hashtags: [], membersCount: 12, isPrivate: false
    }]
  });
  assert.match(html, /<img src="\/uploads\/community\.png" alt="" class="community-glyph"/);
  assert.match(html, /Sketch Club/);
});

test('paid community promotions are separately and transparently labeled in discovery pages', async () => {
  const promoted = [{
    _id: 'c-paid', slug: 'makers', name: 'Makers', description: 'A public maker space',
    category: 'arts', membersCount: 8, isPrivate: false, isPromoted: true
  }];
  const explore = await render('pages/explore.ejs', {
    title: 'Explore', pagePath: '/explore', noIndex: true, query: '', category: '',
    isBrowsing: false, communities: [], promotedCommunities: promoted,
    categories: [], newPeople: [], popularPeople: [], viralPosts: [], risingCommunities: []
  });
  assert.match(explore, /Promoted communities/);
  assert.match(explore, /Promoted · paid with Waves/);
  assert.match(explore, /href="\/communities\/makers"/);

  const directory = await render('pages/communities.ejs', {
    title: 'Communities', pagePath: '/communities', noIndex: true,
    promotedCommunities: promoted, largerCommunities: [], newCommunities: [],
    growingCommunities: [], viralPosts: [], newPosts: [], viralArticles: [],
    latestArticles: [], latestPosts: []
  });
  assert.match(directory, /Promoted communities/);
  assert.match(directory, /Promoted · paid with Waves/);
});

test('admin panel renders MongoDB storage, community categories, and data cleanup controls', async () => {
  const { formatStorage } = require('../src/services/mongoStorage');
  const html = await render('pages/admin.ejs', {
    title: 'Admin console', pagePath: '/admin', noIndex: true,
    users: [], communities: [{
      _id: 'c1', name: 'Sketch Club', owner: null, membersCount: 12,
      isPrivate: false, requireApproval: false, category: 'technology',
      description: 'Draw together', guidelines: '', bannedWords: [],
      monetizationStatus: 'approved', isMonetized: true,
      monetizationSettings: { adsEnabled: true, adPlacement: 'all', adFrequency: 2 }
    }], posts: [], openReports: [{
      _id: 'report-ad-1', targetType: 'advertisement', target: 'campaign-1',
      reason: 'Inappropriate content', contextText: 'Advertisement: Example campaign · Community: design-lab',
      reporter: { name: 'Asha' }, createdAt: new Date('2026-04-20T14:00:00Z')
    }], pendingActions: [],
    pendingMonetization: [{
      _id: 'pending-community', name: 'Pending Space', owner: { name: 'Asha' }, createdAt: new Date(),
      monetizationApplication: { submittedAt: new Date(), goals: 'Support the community.' },
      monetizationSettings: {}
    }],
    suspiciousRewardPairs: [{
      accountA: { id: 'user-a', name: 'Asha' }, accountB: { id: 'user-b', name: 'Ravi' },
      totalRewards: 10, rewardsFromA: 5, rewardsFromB: 5, uniqueTargets: 6, activeDays: 2, totalWaves: 16.25
    }],
    suspiciousAdEvents: [{
      _id: 'bot-signal-1', eventType: 'bot-activity', campaign: { title: 'Launch campaign' },
      community: { name: 'Design Lab' }, viewer: { name: 'Asha' }, attempts: 20,
      lastSeenAt: new Date('2026-04-20T12:00:00Z'),
      reason: 'High-volume ad activity: 20 unique events within one minute.'
    }],
    suspiciousWavesTransfers: [{
      _id: 'waves-signal-1', sender: { name: 'Asha', email: 'asha@example.test' },
      recipient: { name: 'Ravi', email: 'ravi@example.test' }, transferCount: 5,
      totalWaves: 35, lastSeenAt: new Date('2026-04-20T12:00:00Z'),
      reason: 'Repeated transfers to one account.'
    }],
    pendingAppeals: [], moderators: [], auditLogs: [{
      action: 'campaign-rejected', actor: { name: 'Operator', role: 'admin' },
      targetType: 'campaign', target: 'campaign-1', details: { reason: 'Policy violation' },
      createdAt: new Date('2026-04-20T13:00:00Z')
    }],
    maintenanceRuns: [{
      task: 'chats', status: 'success', scheduled: false, triggeredBy: { name: 'Operator' },
      startedAt: new Date('2026-04-20T12:00:00Z'), results: { directMessages: 2 }
    }],
    maintenanceTaskLabels: TASK_LABELS, pinnedPostIds: new Set(),
    siteSettings: {
      siteName: '', tagline: '', registrationOpen: true, postApprovalDefault: false,
      maintenanceMode: false, maintenanceMessage: '', announcement: '',
      postWordLimit: 500, articleWordLimit: 5000, suspensionDefaultDays: 365,
      postReviewThreshold: 2, postPromotionEnabled: true,
      postPromotionWavesCost: 40, postPromotionDurationHours: 36,
      communityPromotionEnabled: true, communityPromotionWavesCost: 65,
      communityPromotionDurationHours: 72, advertisingMinimumCampaignBudget: 35,
      advertisingCostPerImpression: 0.25, advertisingCostPerClick: 2
    },
    mongoStorage: { available: true, percentUsed: 72, percentRemaining: 28, barPercent: 72, usedBytes: 512 * 1024 ** 2, capacityBytes: 712 * 1024 ** 2, remainingBytes: 200 * 1024 ** 2, clusters: 2 },
    formatStorage,
    stats: { users: 0, communities: 0, posts: 0, reports: 0 }
  });
  assert.match(html, /id="admin-panel-maintenance"/);
  assert.match(html, /Possible bot activity/);
  assert.match(html, /20 flagged events\/attempts/);
  assert.match(html, /Suspicious Waves transfer activity/);
  assert.match(html, /Repeated transfers to one account/);
  assert.match(html, /Run all cleanup processes/);
  assert.match(html, /name="communityPromotionEnabled"/);
  assert.match(html, /name="communityPromotionWavesCost"[^>]+value="65"/);
  assert.match(html, /name="communityPromotionDurationHours"[^>]+value="72"/);
  assert.match(html, /name="advertisingMinimumCampaignBudget"[^>]+value="35"/);
  assert.match(html, /name="advertisingCostPerImpression"[^>]+value="0\.25"/);
  assert.match(html, /name="advertisingCostPerClick"[^>]+value="2"/);
  assert.match(html, /name="postPromotionEnabled"/);
  assert.match(html, /name="postPromotionWavesCost"[^>]+value="40"/);
  assert.match(html, /name="postPromotionDurationHours"[^>]+value="36"/);
  assert.match(html, /Recent cleanup runs/);
  assert.match(html, /Run by Operator/);
  assert.match(html, /directMessages&#34;:2/);
  assert.match(html, /value="technology"\s+selected>Technology/);
  assert.match(html, /72% used · 28% left/);
  assert.match(html, /512 MB \/ 712 MB/);
  assert.match(html, /200 MB remaining across 2 clusters/);
  assert.match(html, /Combined filesystem figures reported by the configured MongoDB URLs/);
  assert.match(html, /Enable ads after approval/);
  assert.match(html, /Ads enabled \(uncheck to pause ads\)/);
  assert.match(html, /Frequency \(posts between ads\)/);
  assert.match(html, /Possible coordinated Waves rewards/);
  assert.match(html, /Asha · Ravi/);
  assert.match(html, /not proof of linked accounts/);
  assert.match(html, /advertisement · campaign-1/);
  assert.match(html, /Example campaign/);
  assert.match(html, /Inappropriate content/);
  assert.match(html, /data-filter-audit/);
  assert.match(html, /campaign-rejected/);
  assert.match(html, /Affected campaign · campaign-1/);
  assert.match(html, /Policy violation/);
});

test('admin panel exposes suspend, reinstate, and remove controls for approved campaigns', async () => {
  const { formatStorage } = require('../src/services/mongoStorage');
  const html = await render('pages/admin.ejs', {
    title: 'Admin console', pagePath: '/admin', noIndex: true,
    users: [], communities: [], posts: [], openReports: [], pendingActions: [],
    pendingAppeals: [{
      _id: 'advertiser-appeal-1', actionType: 'advertiser',
      advertiser: { businessName: 'Appealing Co' },
      user: { name: 'Asha', email: 'asha@example.test' },
      createdAt: new Date(), reasonSnapshot: 'Verification issue',
      message: 'Please reconsider my application.'
    }], moderators: [], auditLogs: [], pendingMonetization: [],
    pendingAdvertisers: [], pendingCampaigns: [],
    managedCampaigns: [
      { _id: 'active-1', title: 'Active campaign', status: 'active', advertiser: { businessName: 'Example Co', user: { email: 'ads@example.test' } }, remainingBudget: 90, wavesSpent: 10, targetCommunities: ['c1'] },
      { _id: 'suspended-1', title: 'Suspended campaign', status: 'suspended', suspensionReason: 'Review pending', advertiser: { businessName: 'Example Co' }, remainingBudget: 50, wavesSpent: 50, targetCommunities: [] }
    ],
    maintenanceRuns: [], maintenanceTaskLabels: TASK_LABELS, pinnedPostIds: new Set(),
    siteSettings: {
      siteName: '', tagline: '', registrationOpen: true, postApprovalDefault: false,
      maintenanceMode: false, maintenanceMessage: '', announcement: '',
      postWordLimit: 500, articleWordLimit: 5000, suspensionDefaultDays: 365,
      postReviewThreshold: 2, communityPromotionEnabled: true,
      communityPromotionWavesCost: 65, communityPromotionDurationHours: 72
    },
    mongoStorage: { available: false }, formatStorage,
    stats: { users: 0, communities: 0, posts: 0, reports: 0 }
  });
  assert.match(html, /Approved campaign management/);
  assert.match(html, /action="\/admin\/campaigns\/active-1\/manage"/);
  assert.match(html, /name="action" value="suspend"/);
  assert.match(html, /action="\/admin\/campaigns\/suspended-1\/manage"/);
  assert.match(html, /name="action" value="reinstate"/);
  assert.match(html, /name="action" value="remove"/);
  assert.match(html, /Review pending/);
  assert.match(html, /Advertiser appeal · Appealing Co/);
  assert.match(html, /Approve &amp; restore/);
  assert.match(html, /Deny appeal/);
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

test('mobile navigation drawer includes the personal recap link for signed-in users', async () => {
  const html = await render('partials/app-nav.ejs');
  assert.match(html, /<a href="\/recap">[\s\S]*?Your recap<\/a>/);
});

test('footers link to the new docs and help pages, and the GitHub link uses a real icon (not a stray glyph)', async () => {
  const footer = await render('partials/site-footer.ejs');
  assert.match(footer, /href="\/docs"/);
  assert.match(footer, /href="\/help"/);
  assert.doesNotMatch(footer, /aria-label="Crowdwide on GitHub">⌥/);
  assert.match(footer, /icon-github/);
});

test('public post listing renders guest-readable posts with account-gated interactions and SEO data', async () => {
  const html = await render('pages/public-posts.ejs', {
    currentUser: null,
    title: 'Polls on Crowdwide',
    description: 'Public polls',
    pagePath: '/posts?type=poll',
    canonicalUrl: 'https://crowdwide.example/posts?type=poll',
    ogType: 'website',
    structuredData: { '@context': 'https://schema.org', '@type': 'CollectionPage' },
    noIndex: false,
    type: 'poll',
    posts: [post(101, {
      type: 'poll',
      poll: { question: 'What should we build next?', options: [{ label: 'Better discovery', votes: ['u1'] }] }
    })],
    page: 1,
    hasMore: false,
    total: 1
  });

  assert.match(html, /Good conversations are public/);
  assert.match(html, /What should we build next/);
  assert.match(html, /Create an account to vote/);
  assert.match(html, /Join Crowdwide to like, comment, and share/);
  assert.match(html, /https:\/\/crowdwide\.example\/posts\?type=poll/);
  assert.match(html, /application\/ld\+json/);
  assert.doesNotMatch(html, /<form[^>]+action="\/posts\/p101\/(?:like|poll\/vote)"/);
});

test('guests can read comment threads but only see account-gated comment actions', async () => {
  const html = await render('pages/post-detail.ejs', {
    currentUser: null,
    title: 'Poll by A',
    pagePath: '/posts/p102',
    description: 'A public poll',
    post: {
      ...post(102),
      type: 'poll',
      poll: { question: 'Which topic?', options: [{ label: 'Craft', votes: ['u1'] }] },
      liked: false,
      bookmarked: false,
      quotedPost: null,
      replyTo: null
    },
    comments: [{ _id: 'c1' }],
    commentTree: [{
      _id: 'c1', author: { _id: 'a2', name: 'B' }, body: 'A readable comment',
      createdAt: new Date(), likes: ['u1'], reactions: [], children: []
    }]
  });

  assert.match(html, /A readable comment/);
  assert.match(html, /Create an account to vote in this poll/);
  assert.match(html, /Create an account to like this comment/);
  assert.match(html, /Join the conversation/);
  assert.doesNotMatch(html, /<form[^>]+action="\/(?:posts\/p102\/(?:like|poll\/vote|comments)|comments\/c1\/like)"/);
});
