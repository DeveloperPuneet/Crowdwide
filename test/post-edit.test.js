const test = require('node:test');
const assert = require('node:assert/strict');
const Post = require('../src/models/Post');
const SiteSetting = require('../src/models/SiteSetting');
const { clearSiteConfigCache } = require('../src/services/siteConfig');
const { editPost } = require('../src/controllers/interactionController');

const words = (count) => Array.from({ length: count }, (_, index) => `word${index}`).join(' ');

async function edit(t, { existingCount, submittedCount }) {
  const post = {
    _id: 'post-id',
    author: 'user-id',
    type: 'post',
    body: words(existingCount),
    async save() { this.saved = true; }
  };
  t.mock.method(Post, 'findOne', () => Promise.resolve(post));
  // Edits are written with a compare-and-set on the revision, so a write is "saved" when this is called.
  t.mock.method(Post, 'findOneAndUpdate', () => { post.saved = true; return { select: () => Promise.resolve({ revision: 1 }) }; });
  t.mock.method(SiteSetting, 'getSingleton', () => Promise.resolve({ postWordLimit: 60, articleWordLimit: 300 }));
  clearSiteConfigCache();
  t.after(clearSiteConfigCache);

  const req = {
    params: { id: 'post-id' },
    session: { user: { id: 'user-id' } },
    body: { body: words(submittedCount) },
    get: (header) => header === 'X-Requested-With' ? 'XMLHttpRequest' : null
  };
  const res = { json(payload) { this.payload = payload; } };
  await editPost(req, res);
  return { post, res };
}

test('editing a post above the current word limit is allowed when it does not add words', async (t) => {
  const { post, res } = await edit(t, { existingCount: 65, submittedCount: 65 });
  assert.equal(post.saved, true);
  assert.deepEqual(res.payload, { ok: true, edited: true, revision: 1 });
});

test('editing a post above the current word limit is allowed when reducing its word count', async (t) => {
  const { post, res } = await edit(t, { existingCount: 65, submittedCount: 61 });
  assert.equal(post.saved, true);
  assert.deepEqual(res.payload, { ok: true, edited: true, revision: 1 });
});

test('editing cannot increase a post beyond the current word limit', async (t) => {
  const { post, res } = await edit(t, { existingCount: 60, submittedCount: 61 });
  assert.equal(post.saved, undefined);
  assert.equal(res.payload.ok, false);
  assert.match(res.payload.error, /60 words/);
});


// ---- Revisions: an older save must never overwrite newer text ------------------------------------------------

function editWith(t, { stored, body, revision, updateResult }) {
  const post = { _id: 'post-id', author: 'user-id', type: 'post', body: stored.body, revision: stored.revision };
  t.mock.method(Post, 'findOne', () => Promise.resolve(post));
  const writes = [];
  t.mock.method(Post, 'findOneAndUpdate', (filter, update) => { writes.push({ filter, update }); return { select: () => Promise.resolve(updateResult === undefined ? { revision: stored.revision + 1 } : updateResult) }; });
  // What the database holds when the conflict handler looks again.
  t.mock.method(Post, 'findById', () => ({ select: () => ({ lean: () => Promise.resolve(editWith.latest || { body: stored.body, revision: stored.revision }) }) }));
  t.mock.method(SiteSetting, 'getSingleton', () => Promise.resolve({ postWordLimit: 60, articleWordLimit: 300 }));
  clearSiteConfigCache();
  t.after(() => { clearSiteConfigCache(); delete editWith.latest; });
  const req = {
    params: { id: 'post-id' },
    session: { user: { id: 'user-id' } },
    body: { body, ...(revision === undefined ? {} : { revision: String(revision) }) },
    get: (header) => header === 'X-Requested-With' ? 'XMLHttpRequest' : null
  };
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(payload) { this.payload = payload; } };
  return { post, res, writes, run: () => editPost(req, res) };
}

test('a save against the current revision is written and moves the revision forward', async (t) => {
  const { res, writes, run } = editWith(t, { stored: { body: 'old text', revision: 3 }, body: 'new text', revision: 3 });
  await run();
  assert.deepEqual(res.payload, { ok: true, edited: true, revision: 4 });
  assert.equal(writes[0].filter.revision, 3, 'the write is conditional on the revision that was read');
  assert.deepEqual(writes[0].update.$inc, { revision: 1 });
});

test('a save written against an older revision is refused and leaves the newer text alone', async (t) => {
  const { res, writes, run } = editWith(t, { stored: { body: 'newer text', revision: 5 }, body: 'older text', revision: 4 });
  await run();
  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.ok, false);
  assert.equal(res.payload.conflict, true);
  assert.equal(res.payload.revision, 5);
  assert.equal(writes.length, 0, 'nothing is written for a stale save');
});

test('if another save slips in between the check and the write, the write is refused too', async (t) => {
  editWith.latest = { body: 'someone elses text', revision: 4 };
  const { res, run } = editWith(t, { stored: { body: 'old text', revision: 3 }, body: 'my text', revision: 3, updateResult: null });
  await run();
  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.revision, 4);
});

test('retrying a save whose first try already landed is a success, not a conflict', async (t) => {
  // The reply to the first try was lost (timeout). The text stored is exactly what is being re-sent.
  const { res, writes, run } = editWith(t, { stored: { body: 'my text', revision: 4 }, body: 'my text', revision: 3 });
  await run();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, { ok: true, edited: true, revision: 4, alreadySaved: true });
  assert.equal(writes.length, 0);
});

test('posts created before revisions existed can still be edited', async (t) => {
  const { post, res, writes, run } = editWith(t, { stored: { body: 'old text', revision: undefined }, body: 'new text', revision: 0, updateResult: { revision: 1 } });
  post.revision = undefined;
  await run();
  assert.equal(res.payload.ok, true);
  assert.deepEqual(writes[0].filter.revision, { $in: [0, null] });
});
