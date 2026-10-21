const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { icon } = require('../src/utils/icons');

const views = path.join(__dirname, '../src/views');
const user = { id: 'u1', name: 'Asha Rao', role: 'member', wavesBalance: 3 };
const base = { icon, csrfToken: 'tok', currentUser: user, renderRichBody: (t) => t, preview: (t) => t, renderMentions: (t) => t, plainText: (t) => t };
const post = { _id: 'p1', body: 'Hello thread', author: { _id: 'a1', name: 'Ben' }, createdAt: new Date(Date.now() - 3 * 3600000), likes: ['x'], commentsCount: 2, sharesCount: 1, viewsCount: 9, widewave: { name: 'poetry' }, media: [] };
const render = (file, data = {}) => ejs.renderFile(path.join(views, file), { ...base, ...data });

test('top bar has a Crowdwide | WideWave switch and the mobile bar has a WideWave tab', async () => {
  const home = await render('partials/app-nav.ejs', { active: 'home' });
  assert.match(home, /class="mode-switch"[\s\S]*?href="\/dashboard"[\s\S]*?href="\/widewaves"/);
  assert.match(home, /mode-switch-item is-on" href="\/dashboard"/);
  assert.match(home, /class="bottom-nav"[\s\S]*?href="\/widewaves"[\s\S]*?WideWave/);
  const wide = await render('partials/app-nav.ejs', { active: 'widewaves' });
  assert.match(wide, /mode-switch-ww is-on" href="\/widewaves"/);
  assert.match(wide, /href="\/widewaves#ww-composer"/);
});

test('thread card keeps the hooks the feed JS relies on', async () => {
  const html = await render('partials/thread-card.ejs', { post: { ...post, liked: true } });
  assert.match(html, /class="post-card thread-card"[^>]*data-post-url="\/posts\/p1"/);
  assert.match(html, /class="th-line"/);
  assert.match(html, /ww\/poetry/);
  assert.match(html, /action-like is-liked/);
  assert.match(html, /3h/);
  const hidden = await render('partials/thread-card.ejs', { post, hideSource: true });
  assert.doesNotMatch(hidden, /class="th-ww"/);
});

test('quick composer posts back to the same WideWave and guests are sent to sign up', async () => {
  const html = await render('partials/ww-composer.ejs', { preset: 'poetry', returnTo: '/ww/poetry' });
  assert.match(html, /name="returnTo" value="\/ww\/poetry"/);
  assert.match(html, /data-preset="poetry"/);
  assert.match(html, /action="\/posts"/);
  const guest = await render('partials/ww-composer.ejs', { currentUser: undefined });
  assert.match(guest, /href="\/auth\/register"/);
});

test('post creation only honours safe WideWave return paths', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/controllers/webController.js'), 'utf8');
  assert.match(source, /const backTo = \/\^\\\/\(widewaves\|ww\\\/\[a-z0-9_\]\{1,40\}\)\$\/\.test/);
  const create = source.slice(source.indexOf('exports.createPost'), source.indexOf('exports.createPost') + 9000);
  assert.doesNotMatch(create.slice(0, create.indexOf('Scheduled for') + 400), /res\.redirect\('\/dashboard'\)/);
});

test('WideWave pages and the home strip render', async () => {
  const feed = { posts: [post], hasMore: false };
  const wave = { name: 'poetry', description: 'Verse and poems', hashtags: ['poetry'], postsCount: 4, creator: 'u1' };
  const list = await render('pages/widewaves.ejs', { title: 'x', description: '', pagePath: '/widewaves', tab: 'for-you', page: 1, feed, trending: [wave], recommended: [], board: [], query: '', results: [] });
  assert.match(list, /ww-stories[\s\S]*?href="\/ww\/poetry"/);
  assert.match(list, /class="ww-tabs"/);
  assert.match(list, /id="ww-composer"/);
  assert.match(list, /thread-card/);
  const show = await render('pages/widewave.ejs', { title: 'x', description: '', pagePath: '/ww/poetry', wave, sort: 'new', page: 1, feed, contributors: [], related: [], weekPosts: 1, totalPosts: 4, creator: null, isCreator: false, isStaff: false });
  assert.match(show, /ww\/poetry/);
  assert.match(show, /name="returnTo" value="\/ww\/poetry"/);
  assert.match(show, /thread-card/);
  const strip = await render('partials/widewave-story.ejs', { wave });
  assert.match(strip, /class="ww-story"/);
  const dash = fs.readFileSync(path.join(views, 'pages/dashboard.ejs'), 'utf8');
  assert.match(dash, /ww-home-strip/);
});
