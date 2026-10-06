const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

test('the hidden composer really is hidden: .composer {display:flex} must not override .composer-hidden', () => {
  const css = read('public', 'css', 'style.css');
  assert.match(css, /\.composer\.composer-hidden\s*\{\s*display:\s*none/);
  assert.doesNotMatch(css, /(^|\n)\.composer-hidden\s*\{/);
});

test('the feed card shows content plus likes/comments/shares/views only; reply, report and edit live on the post page', () => {
  const card = read('src', 'views', 'partials', 'post-card.ejs');
  for (const forbidden of ['/reply', '/quote', '/report', '/edit', '/bookmark', '/comments"', 'reaction-bar']) {
    assert.ok(!card.includes(forbidden), `post-card.ejs should not contain ${forbidden}`);
  }
  for (const label of ['Like', 'Comments', 'Share', 'Views']) assert.ok(card.includes(`aria-label="${label}"`));
  const detail = read('src', 'views', 'pages', 'post-detail.ejs');
  for (const needed of ['/reply', '/report', '/edit', '/bookmark']) assert.ok(detail.includes(needed), `post-detail.ejs should contain ${needed}`);
  assert.match(detail, /class="post-tool-link" href="\/posts\/<%= post\._id %>\/edit"/);
  assert.match(detail, /class="post-tool-link" href="\/posts\/<%= post\._id %>\/reply"/);
  assert.doesNotMatch(detail, /class="post-reply-form"|action="\/posts\/<%= post\._id %>\/edit"/);
  assert.ok(!detail.includes('/quote'), 'Quote was removed: it duplicated "Reply with a post"');
});

test('no inline event-handler attributes (the CSP blocks them, so confirmations silently never ran)', () => {
  const dir = path.join(__dirname, '..', 'src', 'views');
  const files = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name)); })(dir);
  for (const file of files) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /\son(submit|click|change|input)=/i, path.basename(file));
});

test('media frames take their own aspect ratio instead of one fixed shape', () => {
  const css = read('public', 'css', 'responsive-media.css');
  assert.match(css, /aspect-ratio:\s*var\(--ar/);
  assert.doesNotMatch(css, /max-height:\s*420px/);
});

test('profile topics stay below the bio and post/comment editors have usable height', () => {
  const css = read('public', 'css', 'style.css');
  const responsive = read('public', 'css', 'responsive-layout.css');
  assert.match(css, /\.profile-hashtags\s*\{\s*margin:\s*12px 0 0/);
  assert.match(css, /\.post-owner-tools textarea\s*\{[^}]*min-height:\s*240px/);
  assert.match(css, /\.comment-form textarea\[name="body"\]\s*\{[^}]*min-height:\s*104px/);
  assert.match(responsive, /\.person-bio\s*\{[^}]*white-space:\s*pre-line/);
  assert.match(responsive, /\.search-user-row > \.person-bio\s*\{[^}]*white-space:\s*pre-line/);
  assert.match(css, /\.chat-text\s*\{\s*margin:\s*0;\s*white-space:\s*pre-wrap/);
  assert.match(css, /\.thread-comment-text\s*\{\s*white-space:\s*pre-wrap/);
  assert.match(read('src', 'views', 'partials', 'comment-form.ejs'), /<textarea[\s\S]*?data-comment-input/);
});

test('avatar images use an empty alt and failed loads reveal the initial fallback', () => {
  const avatar = read('src', 'views', 'partials', 'avatar.ejs');
  assert.match(avatar, /alt="" aria-hidden="true"/);
  assert.match(avatar, /class="avatar-initial"/);
  const groupAvatar = read('src', 'views', 'partials', 'group-avatar.ejs');
  assert.match(groupAvatar, /class="avatar-initial"/);
  assert.doesNotMatch(groupAvatar, /\sonerror=/i);
  const appJs = read('public', 'js', 'app.js');
  assert.match(appJs, /image\.closest\('\.avatar'\).*image\.remove\(\)/s);
  assert.match(appJs, /if \(image\.complete\)[\s\S]*image\.naturalWidth === 0/);
  assert.match(appJs, /image\.addEventListener\('load', \(\) => showLoadedAvatar\(image\)/);
  const css = read('public', 'css', 'style.css');
  assert.match(css, /\.avatar-initial\s*\{[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*color:\s*#fff/s);
  assert.match(css, /\.avatar\.image-loaded \.avatar-initial\s*\{\s*visibility:\s*hidden/);
  assert.match(css, /\.avatar img\s*\{[^}]*opacity:\s*0/);
});

test('avatar initials are geometrically centered and verified profiles use a modern check badge', () => {
  const css = read('public', 'css', 'style.css');
  const profile = read('src', 'views', 'pages', 'profile.ejs');
  assert.match(css, /\.avatar-initial\s*\{[^}]*display:\s*grid;[^}]*place-items:\s*center;/s);
  assert.match(css, /\.verified-tick\s*\{[^}]*display:\s*inline-grid;[^}]*border-radius:\s*50%/s);
  assert.match(profile, /class="verified-tick"[^>]*aria-label="Verified"[^>]*><%- icon\('check'/);
});

test('settings, post composer, and comment controls share refreshed responsive surfaces', () => {
  const css = read('public', 'css', 'style.css');
  assert.match(css, /\.settings-content\s*\{[^}]*border-radius:\s*22px/);
  assert.match(css, /\.post-compose-form\s*\{[^}]*border-radius:\s*20px/);
  assert.match(css, /\.thread-comment-actions\s*\{\s*display:\s*flex;[^}]*align-items:\s*center;/);
  assert.match(css, /\.action-translate-inline\s*\{[^}]*justify-content:\s*flex-end/);
});

test('light and pink themes set readable text, control, and surface colors', () => {
  const css = read('public', 'css', 'style.css');
  assert.match(css, /body\[data-theme="pink"\]\s*\{[^}]*--theme-fg:/s);
  assert.match(css, /:is\(body\[data-theme="light"\], body\[data-theme="pink"\]\) :is\(input/);
  assert.doesNotMatch(css, /:is\(body\[data-theme="light"\], body\[data-theme="pink"\]\) button \{ border-color:/);
  assert.match(css, /:is\(body\[data-theme="light"\], body\[data-theme="pink"\]\) :is\(\.post-card, \.composer/);
  assert.match(css, /\.app-sidebar \{ border-right: 1px solid var\(--theme-border\); \}/);
  assert.match(css, /\.word-limit-meter \{ background: var\(--theme-border\); \}/);
  assert.match(css, /\.composer select, \.coauthor-picker, \.composer-media-meta\) \{ background: var\(--theme-surface\);/);
  assert.match(css, /\.media-picker \{ background: var\(--theme-soft\);/);
  assert.match(css, /\.hashtag-chip:hover \{ background: var\(--theme-accent\);/);
  assert.match(css, /\.post-card\[data-post-url\]:hover \{ border-color: var\(--theme-accent\);/);
  assert.match(css, /\.thread-comment\[data-depth="3"\]\) \{ border-color: var\(--theme-border\);/);
  assert.match(css, /:is\(body\[data-theme="light"\], body\[data-theme="pink"\]\) :is\(\.side-links \.side-active, \.nav-drawer-panel \.side-active\) \{ background: color-mix/);
  assert.match(css, /:is\(body\[data-theme="light"\], body\[data-theme="pink"\]\) :is\(\.comment, \.thread-comment\) \{ border-left: 0;/);
  assert.match(css, /:is\(body\[data-theme="light"\], body\[data-theme="pink"\]\) \.app-sidebar \{ background: transparent; border-right: 0;/);
  assert.match(css, /:is\(body\[data-theme="light"\], body\[data-theme="pink"\]\) :is\(\.follow-button, \.mute-button, \.round-action\):hover/);
  assert.match(css, /:is\(body\[data-theme="light"\], body\[data-theme="pink"\]\) \.popular-search-list a \{ border: 0; background: var\(--theme-soft\);/);
  assert.match(css, /:is\(body\[data-theme="light"\], body\[data-theme="pink"\]\) :is\(\.app-nav nav a:hover, \.app-nav \.app-nav-active, \.site-nav \.nav-links a:hover\) \{ border: 0; background: transparent;/);
  assert.match(css, /:is\(body\[data-theme="light"\], body\[data-theme="pink"\]\) :is\(\.settings-tabs > a:hover, \.settings-nav > a:hover\) \{ border: 0; background: var\(--theme-soft\);/);
  assert.match(css, /:is\(body\[data-theme="light"\], body\[data-theme="pink"\]\) \.notification-button \{ border-color: transparent;/);
  assert.doesNotMatch(css, /:is\(body\[data-theme="light"\], body\[data-theme="pink"\]\) \.community-posts \.post-card \{ border: 0; background: transparent;/);
  assert.match(css, /:is\(body\[data-theme="light"\], body\[data-theme="pink"\]\) \.community-detail-layout \.community-posts \{ background: transparent; border: 0; box-shadow: none;/);
  assert.match(css, /:is\(body\[data-theme="light"\], body\[data-theme="pink"\]\) \.message-thread \.chat-bubble|:is\(body\[data-theme="light"\], body\[data-theme="pink"\]\) \.chat-bubble \{ background: var\(--theme-soft\);/);
  assert.match(css, /:is\(body\[data-theme="light"\], body\[data-theme="pink"\]\) \.post-more > summary:hover \{ background: var\(--theme-soft\); color: var\(--theme-accent\);/);
  assert.match(css, /:is\(body\[data-theme="light"\], body\[data-theme="pink"\]\) :is\(\.chat-back:hover, \.chat-header-action:hover, \.post-back:hover\) \{ background: var\(--theme-soft\); color: var\(--theme-accent\);/);
  assert.match(read('src', 'views', 'pages', 'community-detail.ejs'), /class="community-post-author"/);
  assert.match(css, /:is\(body\[data-theme="light"\], body\[data-theme="pink"\]\) \.conversations-search input:not\(\[type="checkbox"\]\).*\.chat-search input:not\(\[type="checkbox"\]\)/s);
  assert.match(css, /:is\(body\[data-theme="light"\], body\[data-theme="pink"\]\) \.conversations-search:focus-within/);
  assert.match(css, /:is\(body\[data-theme="light"\], body\[data-theme="pink"\]\) \.settings-layout :is\(input:not\(\[type="checkbox"\]\).*textarea, select\):focus/);
  assert.match(css, /:is\(body\[data-theme="light"\], body\[data-theme="pink"\]\) \.profile-avatar-slot \.avatar\.large \{ border-color: var\(--theme-surface\);/);
  const playerCss = read('public', 'css', 'media-player.css');
  assert.match(playerCss, /\.cw-player--audio :is\(\.cw-seek-track, \.cw-volume-range\) \{ background: var\(--theme-border\);/);
  assert.match(playerCss, /\.cw-player--audio \.cw-volume-range::-(webkit|moz)-slider-thumb \{ background: var\(--theme-accent\);/);
});

test('profile post sections do not render an extra theme-dependent surface or border', () => {
  const profile = read('src', 'views', 'pages', 'profile.ejs');
  const css = read('public', 'css', 'style.css');
  assert.equal((profile.match(/class="community-posts profile-posts(?: [^"]*)?"/g) || []).length, 6);
  assert.match(css, /\.profile-posts\s*\{[^}]*background:\s*transparent;[^}]*border:\s*0;[^}]*box-shadow:\s*none;/);
  assert.match(css, /:is\(body\[data-theme="light"\], body\[data-theme="pink"\]\) :is\(\.post-card, \.composer, \.post-view/);
});

test('profile anniversaries adapt to local dates and respect reduced motion', () => {
  const css = read('public', 'css', 'style.css');
  const script = read('public', 'js', 'profile-anniversary.js');
  assert.match(css, /\.profile-anniversary\[hidden\]\s*\{\s*display:\s*none;/);
  assert.match(css, /anniversary-confetti-fall/);
  assert.match(css, /anniversary-cake-bob/);
  assert.match(css, /\.balloon-five/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation-duration:\s*\.01ms !important/);
  assert.match(script, /data-profile-joined-date/);

  const shouldCelebrate = (joinedAt, today) => {
    const celebration = {
      hidden: true,
      dataset: { joinedAt },
      years: { textContent: '' },
      querySelector() { return this.years; }
    };
    const document = {
      querySelector(selector) {
        return selector === '[data-profile-anniversary]' ? celebration : null;
      },
      addEventListener() {}
    };
    class LocalDate extends Date {
      constructor(...args) {
        super(...(args.length ? args : [today]));
      }
    }
    vm.runInNewContext(script, {
      Date: LocalDate,
      document,
      window: { setTimeout() {} }
    });
    return { visible: !celebration.hidden, label: celebration.years.textContent };
  };

  assert.deepEqual(shouldCelebrate('2021-04-15T12:00:00.000Z', '2026-04-15T12:00:00.000Z'), {
    visible: true,
    label: '5 years on Crowdwide'
  });
  assert.equal(shouldCelebrate('2021-04-15T12:00:00.000Z', '2026-04-16T12:00:00.000Z').visible, false);
  assert.equal(shouldCelebrate('2026-04-15T12:00:00.000Z', '2026-04-15T12:00:00.000Z').visible, false);
  assert.equal(shouldCelebrate('2020-02-29T12:00:00.000Z', '2021-02-28T12:00:00.000Z').visible, true);
  assert.equal(shouldCelebrate('2020-02-29T12:00:00.000Z', '2024-02-29T12:00:00.000Z').visible, true);
  assert.equal(shouldCelebrate('2020-02-29T12:00:00.000Z', '2024-02-28T12:00:00.000Z').visible, false);
});

test('public discovery surfaces use theme tokens and responsive filter/navigation layouts', () => {
  const css = read('public', 'css', 'style.css');
  const responsive = read('public', 'css', 'responsive-layout.css');
  for (const token of ['--theme-surface', '--theme-border', '--theme-fg', '--theme-muted', '--theme-accent']) {
    assert.ok(css.includes(token), `public discovery should use ${token}`);
  }
  assert.match(responsive, /@media \(max-width: 760px\)[\s\S]*?\.public-posts-page/);
  assert.match(responsive, /@media \(max-width: 480px\)[\s\S]*?\.public-comments-join/);
});

test('all dark themes boost supporting-text contrast and light themes recolor overlays and admin controls', () => {
  const css = read('public', 'css', 'style.css');
  assert.match(css, /:root\s*\{[^}]*--theme-muted:\s*#c3c6d4/s);
  assert.match(css, /body\[data-theme="dark"\]\s*\{[^}]*--theme-muted:\s*#c8c8c8/s);
  assert.match(css, /body\[data-theme="violet"\]\s*\{[^}]*--theme-muted:\s*#e0d5e8/s);
  assert.match(css, /body\[data-theme="default"\], body\[data-theme="dark"\], body\[data-theme="violet"\]\)[\s\S]*\.post-meta span[\s\S]*color: var\(--theme-muted\)/);
  assert.match(css, /body\[data-theme="light"\], body\[data-theme="pink"\]\)[\s\S]*\.share-menu[\s\S]*background: var\(--theme-surface\)/);
  const adminCss = read('public', 'css', 'admin-panel.css');
  assert.match(adminCss, /body\[data-theme="light"\], body\[data-theme="pink"\]\) \.admin-edit-form select[\s\S]*background: var\(--theme-surface\)/);
  assert.match(adminCss, /body\[data-theme="light"\], body\[data-theme="pink"\]\) \.admin-table td::before[\s\S]*color: var\(--theme-muted\)/);
});

test('menus have distinct, higher-contrast surfaces in dark and light themes', () => {
  const css = read('public', 'css', 'style.css');
  assert.match(css, /--theme-menu:\s*#202338/);
  assert.match(css, /body\[data-theme="dark"\]\s*\{[^}]*--theme-menu:\s*#222/s);
  assert.match(css, /body\[data-theme="violet"\]\s*\{[^}]*--theme-menu:\s*#30213a/s);
  assert.match(css, /body\[data-theme="default"\], body\[data-theme="dark"\], body\[data-theme="violet"\]\)[\s\S]*\.nav-drawer-panel[\s\S]*background-color: var\(--theme-menu\)/);
  assert.match(css, /body\[data-theme="light"\], body\[data-theme="pink"\]\)[\s\S]*\.mention-suggestions[\s\S]*border: 1px solid var\(--theme-menu-border\)/);
  assert.match(css, /body\[data-theme="pink"\]\s*\{[^}]*--theme-menu:\s*#fffafb/s);
});

test('dashboard omits the sidebar promo and light-theme navigation blends into the page surface', () => {
  const dashboard = read('src', 'views', 'pages', 'dashboard.ejs');
  assert.doesNotMatch(dashboard, /Make room for new voices|Every follow shapes your Crowdwide|Read tips to grow/);
  const css = read('public', 'css', 'style.css');
  assert.match(css, /body\[data-theme="light"\], body\[data-theme="pink"\]\) :is\(\.settings-nav, \.app-sidebar\)\s*\{[^}]*background:\s*transparent/s);
  assert.match(css, /body\[data-theme="light"\], body\[data-theme="pink"\]\) :is\(\.app-nav, \.site-nav\)\s*\{[^}]*background:\s*var\(--theme-page\)/s);
});

test('edit and post-reply actions have dedicated page routes and a full-page editor', () => {
  const routes = read('src', 'routes', 'web.js');
  assert.match(routes, /router\.get\('\/posts\/:id\/edit'/);
  assert.match(routes, /router\.get\('\/posts\/:id\/reply'/);
  const page = read('src', 'views', 'pages', 'post-compose.ejs');
  assert.match(page, /post-compose-body/);
  assert.match(read('public', 'css', 'style.css'), /\.post-compose-field textarea\s*\{[^}]*min-height:\s*320px/);
});

test('community workspace uses a responsive form and owned-community list', () => {
  const page = read('src', 'views', 'pages', 'my-communities.ejs');
  assert.match(page, /community-workspace-layout/);
  assert.match(page, /community-workspace-form/);
  assert.match(page, /community-owned-list/);
  assert.match(read('public', 'css', 'style.css'), /\.community-workspace-layout\s*\{\s*display:\s*grid/);
});
