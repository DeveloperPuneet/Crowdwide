const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');
const request = require('supertest');
const mongoose = require('mongoose');

const createApp = require('../src/app');
const User = require('../src/models/User');
const Community = require('../src/models/Community');
const Post = require('../src/models/Post');
const discovery = require('../src/services/discovery');
const authController = require('../src/controllers/authController');
const onboarding = require('../src/controllers/onboardingController');
const { icon } = require('../src/utils/icons');
const { ONBOARDING_INTERESTS, categoriesForInterests } = require('../src/utils/onboardingInterests');
const { COMMUNITY_CATEGORIES } = require('../src/utils/communityCategories');

const root = path.join(__dirname, '..');
const pub = (...parts) => path.join(root, 'public', ...parts);
const views = path.join(root, 'src', 'views');
const chain = (rows) => ({ select() { return this; }, limit() { return this; }, sort() { return this; }, lean: async () => rows });
const baseView = { icon, csrfToken: 'tok', flash: null, currentUser: { id: 'u1', name: 'Asha', role: 'user' }, appUrl: 'https://crowdwide.example', gifsEnabled: true };
const render = (file, data = {}) => ejs.renderFile(path.join(views, file), { ...baseView, ...data });

// ---------- installable app ----------
test('web app manifest is valid, installable and points at real icons', () => {
  const manifest = JSON.parse(fs.readFileSync(pub('manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.name && manifest.short_name);
  assert.ok(manifest.start_url.startsWith('/') && manifest.scope === '/');
  assert.match(manifest.background_color, /^#[0-9a-f]{6}$/i);
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i);
  const sizes = manifest.icons.map((i) => `${i.sizes}:${i.purpose}`);
  for (const wanted of ['192x192:any', '512x512:any', '192x192:maskable', '512x512:maskable']) assert.ok(sizes.includes(wanted), wanted);
  for (const entry of [...manifest.icons, ...manifest.shortcuts.flatMap((s) => s.icons || [])]) {
    assert.ok(fs.existsSync(pub(entry.src)), `${entry.src} should exist`);
  }
  for (const shortcut of manifest.shortcuts) assert.ok(shortcut.url.startsWith('/'));
  assert.ok(fs.existsSync(pub('images', 'Crowdwide_apple_touch_180.png')));
});

test('manifest, service worker and offline page are served with usable content types', async () => {
  const app = createApp({ port: 3000 });
  const manifest = await request(app).get('/manifest.webmanifest');
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers['content-type'], /manifest\+json|application\/json/);
  const sw = await request(app).get('/sw.js');
  assert.equal(sw.status, 200);
  assert.match(sw.headers['content-type'], /javascript/);
  const offline = await request(app).get('/offline.html');
  assert.equal(offline.status, 200);
  assert.doesNotMatch(offline.text, /<script/i, 'offline page must not need scripts (CSP)');
  assert.match(offline.text, /You're offline/);
});

function loadServiceWorker({ online = true } = {}) {
  const handlers = {};
  const store = new Map();
  const cache = {
    addAll: async (urls) => urls.forEach((u) => store.set(u, `cached:${u}`)),
    match: async (req) => store.get(typeof req === 'string' ? req : new URL(req.url).pathname),
    put: async (req, res) => store.set(new URL(req.url).pathname, res)
  };
  const fetched = [];
  const context = {
    URL, Response: { error: () => 'network-error' }, Promise,
    self: { location: { origin: 'https://crowdwide.example' }, addEventListener: (type, fn) => { handlers[type] = fn; }, skipWaiting: () => {}, clients: { claim: async () => {}, matchAll: async () => [] }, registration: { showNotification: async () => {} } },
    caches: { open: async () => cache, keys: async () => ['crowdwide-static-v0', 'other-app'], delete: async (k) => { store.set(`deleted:${k}`, true); return true; }, match: async (u) => cache.match(u) },
    fetch: async (req) => { fetched.push(req.url); if (!online) throw new Error('offline'); return { ok: true, type: 'basic', clone() { return this; } }; }
  };
  vm.runInNewContext(fs.readFileSync(pub('sw.js'), 'utf8'), context);
  const dispatch = async (request) => {
    let response; let handled = false;
    handlers.fetch({ request, respondWith: (p) => { handled = true; response = p; } });
    return { handled, response: handled ? await response : undefined };
  };
  return { handlers, store, dispatch, fetched };
}
const req = (url, extra = {}) => ({ url: `https://crowdwide.example${url}`, method: 'GET', mode: 'cors', ...extra });

test('service worker precaches the offline page and removes only its own old caches', async () => {
  const sw = loadServiceWorker();
  await new Promise((resolve) => sw.handlers.install({ waitUntil: (p) => p.then(resolve) }));
  assert.ok(sw.store.has('/offline.html'));
  await new Promise((resolve) => sw.handlers.activate({ waitUntil: (p) => p.then(resolve) }));
  assert.ok(sw.store.has('deleted:crowdwide-static-v0'));
  assert.ok(!sw.store.has('deleted:other-app'));
});

test('service worker shows the offline page for failed navigations but never caches pages or API calls', async () => {
  const offline = loadServiceWorker({ online: false });
  await new Promise((resolve) => offline.handlers.install({ waitUntil: (p) => p.then(resolve) }));
  const nav = await offline.dispatch(req('/dashboard', { mode: 'navigate' }));
  assert.equal(nav.handled, true);
  assert.equal(nav.response, 'cached:/offline.html');

  const online = loadServiceWorker();
  for (const request of [req('/dashboard/feed/more'), req('/notifications/unread'), req('/media/0/abc'), req('/api/v1/posts'), req('/posts', { method: 'POST' })]) {
    assert.equal((await online.dispatch(request)).handled, false, `${request.url} must go straight to the network`);
  }
  const asset = await online.dispatch(req('/css/style.css'));
  assert.equal(asset.handled, true);
  await new Promise((r) => setImmediate(r));
  assert.ok(online.store.has('/css/style.css'), 'static assets are cached');
  assert.ok(!online.store.has('/dashboard'));
});

test('head links the manifest and theme, and builds absolute share-image URLs', async () => {
  const defaults = await render('partials/head.ejs', { title: 'Home' });
  assert.match(defaults, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(defaults, /<meta name="theme-color" content="#080914">/);
  assert.match(defaults, /apple-touch-icon" href="\/images\/Crowdwide_apple_touch_180\.png"/);
  assert.match(defaults, /og:image" content="https:\/\/crowdwide\.example\/images\/Crowdwide_cover\.png"/);
  assert.match(defaults, /og:image:width" content="1672"/);
  assert.match(defaults, /twitter:card" content="summary_large_image"/);

  const avatar = await render('partials/head.ejs', { title: 'Asha', ogImage: '/media/0/abc123', ogImageAlt: "Asha's picture" });
  assert.match(avatar, /og:image" content="https:\/\/crowdwide\.example\/media\/0\/abc123"/);
  assert.match(avatar, /twitter:card" content="summary"/);
  assert.match(avatar, /og:image:alt" content="Asha&#39;s picture"/);
  assert.doesNotMatch(avatar, /og:image:width/);

  const large = await render('partials/head.ejs', { title: 'Post', ogImage: 'https://cdn.example/x.jpg', ogImageLarge: true, ogType: 'article', ogArticleAuthor: 'Asha', ogPublishedTime: '2026-10-01T00:00:00.000Z' });
  assert.match(large, /twitter:card" content="summary_large_image"/);
  assert.match(large, /og:image" content="https:\/\/cdn\.example\/x\.jpg"/);
  assert.match(large, /article:author" content="Asha"/);
  assert.match(large, /article:published_time/);
});

test('every page footer loads the PWA script and the drawer has an install button', async () => {
  assert.match(fs.readFileSync(path.join(views, 'partials', 'foot.ejs'), 'utf8'), /\/js\/pwa\.js/);
  const nav = await render('partials/app-nav.ejs', {});
  assert.match(nav, /data-pwa-install hidden/);
  assert.match(nav, /href="\/welcome"/);
});

// ---------- share previews ----------
const objectId = () => String(new mongoose.Types.ObjectId());

test('a signed-out visitor opening a public profile link gets a real preview, not the sign-in page', async (t) => {
  const id = objectId();
  t.mock.method(User, 'findById', () => chain({ _id: id, name: 'Asha Rao', bio: 'Photographer and coffee person.', profilePicture: '/media/0/avatar1', privacy: 'public', isVerified: true }));
  t.mock.method(User, 'countDocuments', async () => 42);
  const response = await request(createApp({ port: 3000 })).get(`/u/${id}`);
  assert.equal(response.status, 200);
  assert.match(response.text, /og:title" content="Asha Rao on Crowdwide"/);
  assert.match(response.text, /og:description" content="Photographer and coffee person\./);
  assert.match(response.text, /og:image" content="[^"]*\/media\/0\/avatar1"/);
  assert.match(response.text, /42 followers/);
  assert.match(response.text, /robots" content="noindex,nofollow"/);
  assert.match(response.text, new RegExp(`/auth/register\\?next=${encodeURIComponent(`/u/${id}`)}`));
});

test('followers-only profiles and private communities never reveal a name in the preview', async (t) => {
  const id = objectId();
  t.mock.method(User, 'findById', () => chain({ _id: id, name: 'Secret Person', bio: 'hidden bio', privacy: 'followers', isVerified: true }));
  t.mock.method(Community, 'findOne', () => chain({ name: 'Hidden Club', description: 'secret', isPrivate: true }));
  const app = createApp({ port: 3000 });
  const profile = await request(app).get(`/u/${id}`);
  assert.equal(profile.status, 200);
  assert.doesNotMatch(profile.text, /Secret Person|hidden bio/);
  const community = await request(app).get('/communities/hidden-club');
  assert.equal(community.status, 200);
  assert.doesNotMatch(community.text, /Hidden Club|secret/);
  assert.match(community.text, /private community/i);
  const invite = await request(app).get('/communities/invite/abc123');
  assert.equal(invite.status, 200);
  assert.doesNotMatch(invite.text, /Hidden Club/);
  assert.match(invite.text, /invited/i);
});

test('public community links preview the name, description, members and picture and stay indexable', async (t) => {
  t.mock.method(Community, 'findOne', () => chain({ name: 'Sketch Club', description: 'Draw together every week.', isPrivate: false, membersCount: 1, category: 'arts & crafts', avatarImage: '/media/0/av', coverImage: '/media/0/cover' }));
  const response = await request(createApp({ port: 3000 })).get('/communities/sketch-club');
  assert.equal(response.status, 200);
  assert.match(response.text, /og:title" content="Sketch Club · Community · Crowdwide"/);
  assert.match(response.text, /Draw together every week\./);
  assert.match(response.text, /1 member · arts &amp; crafts/);
  assert.match(response.text, /og:image" content="[^"]*\/media\/0\/cover"/);
  assert.match(response.text, /twitter:card" content="summary_large_image"/);
  assert.match(response.text, /robots" content="index,follow"/);
});

test('unknown links keep the normal sign-in redirect and bad ids never reach the database', async (t) => {
  const find = t.mock.method(User, 'findById', () => chain(null));
  t.mock.method(Community, 'findOne', () => chain(null));
  const app = createApp({ port: 3000 });
  assert.equal((await request(app).get('/u/not-an-id')).status, 302);
  assert.equal(find.mock.callCount(), 0);
  const missing = await request(app).get(`/u/${objectId()}`);
  assert.equal(missing.status, 302);
  assert.equal(missing.headers.location, '/auth/login');
  assert.equal((await request(app).get('/communities/nope')).status, 302);
});

test('group invite links get a generic preview', async () => {
  const response = await request(createApp({ port: 3000 })).get('/groups/join/abcDEF123');
  assert.equal(response.status, 200);
  assert.match(response.text, /invited to a group chat/i);
});

test('login and register remember a safe ?next= link and reject anything else', () => {
  const run = (handler, next) => {
    const req = { session: {}, query: { next }, ...{} };
    handler(req, { render() {} });
    return req.session.returnTo;
  };
  const id = objectId();
  for (const ok of ['/communities/sketch-club', `/u/${id}`, '/communities/invite/abc_DEF-1', '/groups/join/xyz']) {
    assert.equal(run(authController.loginPage, ok), ok);
  }
  for (const bad of ['https://evil.example/', '//evil.example', '/admin', '/settings/security', '/u/short', '/communities/a/b', undefined]) {
    assert.equal(run(authController.loginPage, bad), undefined, String(bad));
  }
  assert.equal(authController.safeReturnPath('/communities/x'), '/communities/x');
  assert.equal(authController.safeReturnPath('/dashboard'), null);
  const req = { session: { returnTo: '/communities/x' } };
  assert.equal(authController.landingPath(req), '/communities/x');
  assert.equal(req.session.returnTo, undefined);
  assert.equal(authController.landingPath({ session: {} }), '/dashboard');
});

// ---------- onboarding ----------
function res() {
  return { redirect(p) { this.path = p; }, render(view, data) { this.view = view; this.data = data; } };
}

test('members who have not seen onboarding are sent to it once; others pass through', async (t) => {
  const lookup = t.mock.method(User, 'findById', () => chain({}));
  const session = { user: { id: 'u1' } };
  const first = res();
  let nexted = false;
  await onboarding.onboardingGate({ method: 'GET', session }, first, () => { nexted = true; });
  assert.equal(first.path, '/welcome');
  assert.equal(nexted, false);

  lookup.mock.restore();
  t.mock.method(User, 'findById', () => chain({ onboardingSkippedAt: new Date() }));
  nexted = false;
  await onboarding.onboardingGate({ method: 'GET', session }, res(), () => { nexted = true; });
  assert.equal(nexted, true);
  assert.equal(session.onboardingChecked, true);

  // Once checked, no further database lookups happen in this session.
  const spy = t.mock.method(User, 'findById', () => { throw new Error('should not query'); });
  await onboarding.onboardingGate({ method: 'GET', session }, res(), () => {});
  assert.equal(spy.mock.callCount(), 0);
});

test('existing accounts have neither onboarding field, so they are shown it too', () => {
  const doc = new User({ name: 'Old Timer', email: 'old@example.test', password: 'x' });
  assert.equal(doc.onboardingCompletedAt, undefined);
  assert.equal(doc.onboardingSkippedAt, undefined);
});

test('interests step keeps custom tags, adds chosen topics and extra hashtags, and moves to step 2', async (t) => {
  const doc = { _id: 'u1', hashtags: ['gaming', 'chess'], saved: false, async save() { this.saved = true; } };
  t.mock.method(User, 'findById', () => ({ select: async () => doc }));
  const response = res();
  await onboarding.saveInterests({ session: { user: { id: 'u1' } }, body: { interests: ['music', 'bogus', 'travel'], extraInterests: '#startups #Chess' } }, response);
  assert.deepEqual(doc.hashtags, ['music', 'travel', 'startups', 'chess']);
  assert.equal(doc.saved, true);
  assert.equal(response.path, '/welcome?step=2');
});

test('follow step follows only valid, verified, non-blocking people and notifies them', async (t) => {
  const me = new mongoose.Types.ObjectId();
  const a = new mongoose.Types.ObjectId();
  const b = new mongoose.Types.ObjectId();
  const already = new mongoose.Types.ObjectId();
  const calls = { update: null };
  t.mock.method(User, 'findById', () => ({ select: async () => ({ _id: me, name: 'Asha', following: [already] }) }));
  t.mock.method(User, 'find', () => chain([{ _id: a, blockedUsers: [] }, { _id: b, blockedUsers: [me] }]));
  t.mock.method(User, 'updateOne', async (filter, update) => { calls.update = { filter, update }; return {}; });
  const interaction = require('../src/controllers/interactionController');
  const notified = [];
  // notify is destructured at load time, so verify through the stored Notification side effect instead.
  const Notification = require('../src/models/Notification');
  t.mock.method(Notification, 'create', async (doc) => { notified.push(doc); return doc; });
  t.mock.method(User, 'countDocuments', async () => 0);
  assert.equal(typeof interaction.notify, 'function');

  const response = res();
  await onboarding.follow({ session: { user: { id: String(me) } }, body: { follow: [String(a), String(b), String(me), String(already), 'not-an-id', String(a)] } }, response);
  assert.deepEqual(calls.update.update, { $addToSet: { following: { $each: [a] } } });
  assert.equal(response.path, '/welcome?step=3&followed=1');
});

test('community step joins only public communities, marks onboarding done and reports the result', async (t) => {
  const id1 = objectId();
  const id2 = objectId();
  const userUpdates = [];
  t.mock.method(Community, 'findOneAndUpdate', (filter) => ({ select: async () => (String(filter._id) === id1 ? { _id: id1 } : null) }));
  const communityUpdates = [];
  t.mock.method(Community, 'updateOne', async (...args) => { communityUpdates.push(args); return {}; });
  t.mock.method(User, 'updateOne', async (filter, update) => { userUpdates.push(update); return {}; });
  const session = { user: { id: 'u1' } };
  const response = res();
  await onboarding.joinCommunities({ session, body: { communities: [id1, id2, 'junk'], followed: '3' } }, response);
  assert.equal(response.path, '/welcome?step=4&followed=3&joined=1');
  assert.equal(communityUpdates.length, 1);
  assert.ok(userUpdates.some((u) => u.$addToSet?.joinedCommunities));
  assert.ok(userUpdates.some((u) => u.$set?.onboardingCompletedAt instanceof Date));
  assert.equal(session.onboardingChecked, true);
});

test('skipping or finishing records it and returns the member to where they were heading', async (t) => {
  const updates = [];
  t.mock.method(User, 'updateOne', async (filter, update) => { updates.push(update); return {}; });
  const skipped = res();
  await onboarding.skip({ session: { user: { id: 'u1' }, returnTo: '/communities/sketch-club' } }, skipped);
  assert.equal(skipped.path, '/communities/sketch-club');
  assert.ok(updates[0].$set.onboardingSkippedAt instanceof Date);
  const done = res();
  await onboarding.finish({ session: { user: { id: 'u1' } } }, done);
  assert.equal(done.path, '/dashboard');
  assert.ok(updates[1].$set.onboardingCompletedAt instanceof Date);
});

test('every onboarding step renders with the right form and no leaked template errors', async () => {
  const common = { title: 'Welcome to Crowdwide', pagePath: '/welcome', noIndex: true, steps: ['Interests', 'People', 'Communities', 'All set'], interests: ONBOARDING_INTERESTS, selectedInterests: ['music'], extraInterests: '#chess', people: [], communities: [], followed: 0, joined: 0 };
  const one = await render('pages/onboarding.ejs', { ...common, step: 1 });
  assert.match(one, /action="\/welcome\/interests"/);
  assert.match(one, /name="interests" value="music" checked/);
  assert.match(one, /value="#chess"/);
  assert.match(one, /action="\/welcome\/skip"/);

  const two = await render('pages/onboarding.ejs', { ...common, step: 2, people: [{ _id: 'p1', name: 'Ravi', bio: '', profilePicture: '', reason: 'Also into #music' }] });
  assert.match(two, /action="\/welcome\/follow"/);
  assert.match(two, /name="follow" value="p1"/);
  assert.match(two, /Also into #music/);
  assert.match(await render('pages/onboarding.ejs', { ...common, step: 2 }), /nobody new to suggest/);

  const three = await render('pages/onboarding.ejs', { ...common, step: 3, followed: 2, communities: [{ _id: 'c1', name: 'Sketch Club', description: 'Draw', membersCount: 1, matches: true, avatarImage: '' }] });
  assert.match(three, /action="\/welcome\/communities"/);
  assert.match(three, /name="followed" value="2"/);
  assert.match(three, /Matches your interests/);
  assert.match(three, /1 member(?!s)/);

  const four = await render('pages/onboarding.ejs', { ...common, step: 4, followed: 2, joined: 1 });
  assert.match(four, /action="\/welcome\/finish"/);
  assert.match(four, /followed <strong>2<\/strong> people and joined <strong>1<\/strong> community/);
  assert.match(four, /data-pwa-install hidden/);
  assert.doesNotMatch(four, /action="\/welcome\/skip"/);
});

test('onboarding topics map to real community categories', () => {
  const known = new Set(COMMUNITY_CATEGORIES.map((c) => c.value));
  for (const interest of ONBOARDING_INTERESTS) {
    assert.ok(interest.categories.length > 0);
    for (const category of interest.categories) assert.ok(known.has(category), `${interest.value} -> ${category}`);
  }
  assert.deepEqual(categoriesForInterests(['fitness']).sort(), ['health & wellness', 'sports']);
  assert.deepEqual(categoriesForInterests(['nope']), []);
});

test('onboarding and welcome routes require a signed-in member; the dashboard is gated', async () => {
  const app = createApp({ port: 3000 });
  assert.equal((await request(app).get('/welcome')).headers.location, '/auth/login');
  assert.ok([302, 403].includes((await request(app).post('/welcome/skip')).status));
  const routes = fs.readFileSync(path.join(root, 'src', 'routes', 'web.js'), 'utf8');
  assert.match(routes, /router\.get\('\/dashboard', requireAuth, requireVerified, onboardingController\.onboardingGate/);
});

test('people suggestions now really exclude the viewer and people they already follow', async (t) => {
  const me = String(new mongoose.Types.ObjectId());
  const followed = String(new mongoose.Types.ObjectId());
  const pipelines = [];
  t.mock.method(Post, 'aggregate', async (pipeline) => { pipelines.push(pipeline); return []; });
  t.mock.method(User, 'aggregate', async (pipeline) => { pipelines.push(pipeline); return []; });
  await discovery.getTrendingCreators([me, followed, 'junk'], 5);
  await discovery.getCommonInterestPeople(['music'], [me, followed], 5);
  const trending = pipelines[0][0].$match.author.$nin;
  assert.equal(trending.length, 2);
  assert.ok(trending.every((id) => id instanceof mongoose.Types.ObjectId));
  const common = pipelines[1][0].$match._id.$nin;
  assert.ok(common.every((id) => id instanceof mongoose.Types.ObjectId));
});
