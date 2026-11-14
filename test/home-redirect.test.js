const test = require('node:test');
const assert = require('node:assert/strict');
const controller = require('../src/controllers/webController');

function run(session, query = {}) {
  const out = {};
  const res = { set() { return res; }, redirect(code, url) { out.code = code; out.url = url; }, render(view) { out.view = view; } };
  return controller.home({ session, query }, res).then(() => out);
}

test('verified signed-in members are redirected from / to /dashboard', async () => {
  const out = await run({ user: { id: '1', isVerified: true } });
  assert.equal(out.code, 302);
  assert.equal(out.url, '/dashboard');
});

test('?landing=1 still shows the public homepage to members', async () => {
  const out = await run({ user: { id: '1', isVerified: true } }, { landing: '1' });
  assert.equal(out.url, undefined);
  assert.equal(out.view, 'pages/home');
});

test('signed-out and unverified visitors are not redirected', async () => {
  for (const s of [{}, { user: { id: '1', isVerified: false } }]) {
    const out = await run(s);
    assert.equal(out.url, undefined);
    assert.equal(out.view, 'pages/home');
  }
});
