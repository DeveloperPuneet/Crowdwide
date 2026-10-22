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

test('WideWave has its own logo, different from the Waves coin', () => {
  const ww = icon('widewave', { size: 20 });
  const coin = icon('waves', { size: 20 });
  assert.notEqual(ww, coin);
  assert.match(ww, /linearGradient/);
  assert.ok(fs.existsSync(path.join(__dirname, '../public/images/widewave-logo.svg')));
  for (const file of ['partials/app-nav.ejs', 'partials/ww-composer.ejs', 'partials/post-card.ejs', 'pages/widewaves.ejs']) {
    const source = fs.readFileSync(path.join(views, file), 'utf8');
    const waveLines = source.split('\n').filter((line) => /WideWave|widewave|ww-chip|ww-tool/.test(line));
    assert.ok(waveLines.some((line) => line.includes("icon('widewave'")), file);
  }
});

test('home top bar drops the links the sidebar already has, and the sidebar starts collapsed', async () => {
  const header = (html) => html.slice(0, html.indexOf('</header>'));
  const withSide = await render('partials/app-nav.ejs', { active: 'home' });
  assert.doesNotMatch(header(withSide), /href="\/explore"/);
  assert.doesNotMatch(header(withSide), /href="\/communities"/);
  assert.match(header(withSide), /class="mode-switch"/);
  assert.match(header(withSide), /app-nav-more/);
  const guest = await render('partials/app-nav.ejs', { active: 'explore', currentUser: undefined });
  assert.match(header(guest), /href="\/explore"/);
  const dash = fs.readFileSync(path.join(views, 'pages/dashboard.ejs'), 'utf8');
  assert.match(dash, /app-layout dashboard-modern sidebar-collapsed/);
  assert.match(dash, /data-sidebar-toggle aria-expanded="false"/);
  const js = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  assert.match(js, /cw-sidebar/);
});

test('every other signed-in page gets the same sidebar rail, and "More" exists only on the home page', async () => {
  const header = (html) => html.slice(0, html.indexOf('</header>'));
  for (const active of ['explore', 'communities', 'messages', 'settings', 'widewaves', '']) {
    const html = await render('partials/app-nav.ejs', { active });
    assert.match(html, /class="app-rail"/, active);
    assert.match(html, /data-rail-toggle aria-expanded="false"/, active);
    assert.doesNotMatch(header(html), /app-nav-more/, active);
    assert.doesNotMatch(header(html), /href="\/explore"/, active);
    assert.doesNotMatch(html, /<details class="nav-drawer-more"/, active);
    assert.match(html, /href="\/advertising"/, active);
    assert.match(html, /href="\/wallet"/, active);
  }
  const home = await render('partials/app-nav.ejs', { active: 'home' });
  assert.doesNotMatch(home, /class="app-rail"/);
  assert.match(home, /<details class="nav-drawer-more"/);
  const wide = await render('partials/app-nav.ejs', { active: 'widewaves' });
  assert.match(wide, /Top threads/);
  assert.match(wide, /Back to Crowdwide/);
  assert.match(wide, /href="\/widewaves\/leaderboard"/);
  assert.match(wide, /class="bottom-nav"[\s\S]*?Boards/);
  const mod = await render('partials/app-nav.ejs', { active: 'explore', currentUser: { ...user, role: 'admin' } });
  assert.match(mod, /app-rail[\s\S]*?href="\/admin\/blocked-ips"/);
  const css = fs.readFileSync(path.join(__dirname, '../public/css/style.css'), 'utf8');
  assert.match(css, /body:has\(\.app-rail\)/);
});

test('feed has single Posts and Articles tabs with New | Viral underneath', () => {
  const dash = fs.readFileSync(path.join(views, 'pages/dashboard.ejs'), 'utf8');
  assert.match(dash, /'Posts', 'file-text', \['posts-new', 'posts-viral'\]/);
  assert.match(dash, /'Articles', 'edit', \['articles-new', 'articles-viral'\]/);
  assert.doesNotMatch(dash, /Posts · New|Articles · Viral/);
  assert.match(dash, /class="feed-subtabs"/);
  assert.match(dash, /view=<%= subSorts\[0\] %>-viral/);
});

test('WideWaves accept a picture on create and edit and show it', async () => {
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/web.js'), 'utf8');
  assert.match(route, /router\.post\('\/widewaves'[^\n]*widewaveUpload[^\n]*validateWideWaveUpload/);
  assert.match(route, /router\.post\('\/ww\/:name\/edit'[^\n]*widewaveUpload[^\n]*validateWideWaveUpload/);
  assert.match(require('../src/models/WideWave').schema.path('picture').instance, /String/);
  const story = await render('partials/widewave-story.ejs', { wave: { name: 'poetry', picture: '/media/x.png' } });
  assert.match(story, /<img src="\/media\/x\.png"/);
  const plain = await render('partials/widewave-story.ejs', { wave: { name: 'poetry' } });
  assert.match(plain, />P</);
  const form = await render('pages/widewave-new.ejs', { title: 'x', pagePath: '/widewaves/new', form: { name: '', description: '', hashtags: '' }, limits: { perDay: 3 } });
  assert.match(form, /enctype="multipart\/form-data"/);
  assert.match(form, /name="picture"/);
});
