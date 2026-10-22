const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldCount, reset } = require('../src/utils/viewDedupe');

test('a view counts once per viewer per window and ignores the url', () => {
  reset();
  const req = { ip: '1.2.3.4', session: {} };
  assert.equal(shouldCount('post', 'p1', req, 1000), true);
  assert.equal(shouldCount('post', 'p1', req, 5000), false);
  assert.equal(shouldCount('post', 'p2', req, 5000), true);
  assert.equal(shouldCount('post', 'p1', { ip: '9.9.9.9', session: { user: { id: 'u1' } } }, 5000), true);
  assert.equal(shouldCount('post', 'p1', req, 1000 + 31 * 60 * 1000), true);
});

test('post cards link to the replies-with-a-post page', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/views/partials/post-card.ejs'), 'utf8');
  assert.match(src, /\/replies-with-posts/);
});
