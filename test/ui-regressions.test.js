const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
  assert.match(css, /\.profile-hashtags\s*\{\s*margin:\s*12px 0 0/);
  assert.match(css, /\.post-owner-tools textarea\s*\{[^}]*min-height:\s*240px/);
  assert.match(css, /\.comment-form textarea\[name="body"\]\s*\{[^}]*min-height:\s*104px/);
  assert.match(read('src', 'views', 'partials', 'comment-form.ejs'), /<textarea[\s\S]*?data-comment-input/);
});

test('avatar images use an empty alt and failed loads reveal the initial fallback', () => {
  const avatar = read('src', 'views', 'partials', 'avatar.ejs');
  assert.match(avatar, /alt="" aria-hidden="true"/);
  assert.match(avatar, /class="avatar-initial"/);
  assert.match(read('public', 'js', 'app.js'), /image\.closest\('\.avatar'\).*image\.remove\(\)/s);
  assert.match(read('public', 'js', 'app.js'), /image\.complete && image\.naturalWidth === 0/);
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
  assert.match(css, /:is\(body\[data-theme="light"\], body\[data-theme="pink"\]\) \.community-posts \.post-card \{ border: 0; background: transparent;/);
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
