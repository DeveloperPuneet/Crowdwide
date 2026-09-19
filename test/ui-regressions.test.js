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

test('the feed card shows content plus likes/comments/shares/views only; reply, quote, report and edit live on the post page', () => {
  const card = read('src', 'views', 'partials', 'post-card.ejs');
  for (const forbidden of ['/reply', '/quote', '/report', '/edit', '/bookmark', '/comments"', 'reaction-bar']) {
    assert.ok(!card.includes(forbidden), `post-card.ejs should not contain ${forbidden}`);
  }
  for (const label of ['Like', 'Comments', 'Share', 'Views']) assert.ok(card.includes(`aria-label="${label}"`));
  const detail = read('src', 'views', 'pages', 'post-detail.ejs');
  for (const needed of ['/reply', '/quote', '/report', '/edit', '/bookmark']) assert.ok(detail.includes(needed), `post-detail.ejs should contain ${needed}`);
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
