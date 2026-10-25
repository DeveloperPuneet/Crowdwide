const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false); // background side effects fail fast instead of waiting on a database
const Post = require('../src/models/Post');
const User = require('../src/models/User');
const SiteSetting = require('../src/models/SiteSetting');
const { clearSiteConfigCache } = require('../src/services/siteConfig');
const { createPost } = require('../src/controllers/webController');

const chain = (value) => ({ select() { return this; }, lean: () => Promise.resolve(value), then: (resolve, reject) => Promise.resolve(value).then(resolve, reject) });

function setup(t, { existing = null, create } = {}) {
  const calls = { create: 0, lookups: 0 };
  t.mock.method(User, 'findById', () => chain({ bookmarks: [] }));
  t.mock.method(SiteSetting, 'getSingleton', () => Promise.resolve({ postWordLimit: 60, articleWordLimit: 300 }));
  clearSiteConfigCache();
  t.after(clearSiteConfigCache);
  t.mock.method(Post, 'findOne', (filter) => {
    if (filter && filter.clientRequestId) { calls.lookups += 1; return chain(typeof existing === 'function' ? existing() : existing); }
    return chain(null); // "already posted this recently" check
  });
  t.mock.method(Post, 'create', async (doc) => {
    calls.create += 1;
    if (create) return create(doc);
    return { _id: 'new-post', hashtags: [], toObject: () => ({ _id: 'new-post', status: doc.status, scheduledAt: doc.scheduledAt }), ...doc };
  });
  return calls;
}

function request(body = {}, { json = true } = {}) {
  const req = {
    body: { body: 'A thought worth sharing', ...body },
    files: [],
    session: { user: { id: 'u1' } },
    get: (header) => (json && header === 'X-Requested-With' ? 'XMLHttpRequest' : null)
  };
  const res = {
    statusCode: 200, locals: { csrfToken: 'tok' },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; },
    redirect(url) { this.redirectedTo = url; },
    render(view, data, callback) { callback(null, `<article id="post-${data.posts[0]._id}"></article>`); }
  };
  return { req, res };
}

test('a retry with a request id that already created a post returns that post and creates nothing', async (t) => {
  const calls = setup(t, { existing: { _id: 'old-post', status: 'draft' } });
  const { req, res } = request({ clientRequestId: 'attempt-0001-abcd' });
  await createPost(req, res);
  assert.equal(calls.create, 0, 'no second post');
  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.id, 'old-post');
  assert.equal(res.payload.duplicate, true);
});

test('two copies of the same attempt at once: the second is told to wait and creates nothing', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = setup(t, { create: async (doc) => { await gate; return { _id: 'new-post', hashtags: [], toObject: () => ({ _id: 'new-post', status: doc.status }) }; } });
  const first = request({ clientRequestId: 'attempt-0002-abcd', saveAsDraft: 'on' });
  const second = request({ clientRequestId: 'attempt-0002-abcd', saveAsDraft: 'on' });
  const firstDone = createPost(first.req, first.res);
  await new Promise((resolve) => setImmediate(resolve)); // let the first reach Post.create
  await createPost(second.req, second.res);
  assert.equal(second.res.statusCode, 409);
  assert.equal(second.res.payload.inProgress, true);
  release();
  await firstDone;
  assert.equal(calls.create, 1, 'exactly one post for two taps');
  assert.equal(first.res.payload.ok, true);
});

test('the unique index is the backstop: a duplicate-key error returns the post that won', async (t) => {
  let found = null;
  const calls = setup(t, {
    existing: () => found,
    create: async () => { found = { _id: 'winner', status: 'draft' }; const error = new Error('E11000 duplicate key'); error.code = 11000; throw error; }
  });
  const { req, res } = request({ clientRequestId: 'attempt-0003-abcd', saveAsDraft: 'on' });
  await createPost(req, res);
  assert.equal(calls.create, 1);
  assert.equal(res.payload.id, 'winner');
  assert.equal(res.payload.duplicate, true);
});

test('a published post comes back with its rendered feed card so the temporary card can be swapped', async (t) => {
  setup(t);
  t.mock.method(Post, 'find', () => chain([{ _id: 'new-post', body: 'A thought worth sharing', author: 'u1', likes: [] }]));
  t.mock.method(Post, 'populate', async (docs) => docs.map((doc) => ({ ...doc, author: { _id: 'u1', name: 'Asha' } })));
  t.mock.method(Post, 'aggregate', async () => []);
  const { req, res } = request({ clientRequestId: 'attempt-0004-abcd' });
  await createPost(req, res);
  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.status, 'published');
  assert.match(res.payload.html, /id="post-new-post"/);
  assert.equal(res.payload.url, '/posts/new-post');
});

test('a rejected post answers the in-page composer with a JSON error (and creates nothing)', async (t) => {
  const calls = setup(t);
  const { req, res } = request({ body: Array.from({ length: 80 }, (_, i) => `w${i}`).join(' '), clientRequestId: 'attempt-0005-abcd' });
  await createPost(req, res);
  assert.equal(res.statusCode, 422);
  assert.equal(res.payload.ok, false);
  assert.match(res.payload.error, /60 words/);
  assert.equal(calls.create, 0);
});

test('a plain form post still gets the flash message and redirect', async (t) => {
  setup(t);
  const { req, res } = request({ body: '' }, { json: false });
  await createPost(req, res);
  assert.equal(res.redirectedTo, '/dashboard');
  assert.equal(req.session.flash.type, 'error');
});

test('a malformed request id is ignored rather than trusted', async (t) => {
  const calls = setup(t);
  const { req, res } = request({ clientRequestId: 'x', saveAsDraft: 'on' });
  await createPost(req, res);
  assert.equal(calls.lookups, 0);
  assert.equal(calls.create, 1);
  assert.equal(res.payload.ok, true);
});
