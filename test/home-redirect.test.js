const test = require('node:test');
const assert = require('node:assert/strict');
const controller = require('../src/controllers/webController');
const User = require('../src/models/User');

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

test('homepage Waves endpoint returns only the public top five and disables caching', async (t) => {
  const previousReadyState = User.db.readyState;
  User.db.readyState = 1;
  t.after(() => { User.db.readyState = previousReadyState; });

  const leaders = Array.from({ length: 5 }, (_, index) => ({ _id: `u${index + 1}`, name: `Member ${index + 1}`, profilePicture: '', wavesBalance: 100 - index }));
  t.mock.method(User, 'find', (filter) => {
    assert.deepEqual(filter, { isVerified: true, privacy: 'public', wavesBalance: { $gt: 0 } });
    return {
      sort(value) { assert.deepEqual(value, { wavesBalance: -1, _id: 1 }); return this; },
      limit(value) { assert.equal(value, 5); return this; },
      select(value) { assert.equal(value, '_id name profilePicture wavesBalance'); return this; },
      lean() { return Promise.resolve(leaders); }
    };
  });

  const out = {};
  const res = {
    set(name, value) { out[name] = value; return this; },
    json(payload) { out.payload = payload; return this; }
  };
  await controller.topWaveEarners({}, res);

  assert.equal(out['Cache-Control'], 'no-store');
  assert.deepEqual(out.payload.users, leaders);
  assert.ok(Number.isFinite(Date.parse(out.payload.updatedAt)));
});
