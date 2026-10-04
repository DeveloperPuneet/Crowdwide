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
  assert.deepEqual(res.payload, { ok: true, edited: true });
});

test('editing a post above the current word limit is allowed when reducing its word count', async (t) => {
  const { post, res } = await edit(t, { existingCount: 65, submittedCount: 61 });
  assert.equal(post.saved, true);
  assert.deepEqual(res.payload, { ok: true, edited: true });
});

test('editing cannot increase a post beyond the current word limit', async (t) => {
  const { post, res } = await edit(t, { existingCount: 60, submittedCount: 61 });
  assert.equal(post.saved, undefined);
  assert.equal(res.payload.ok, false);
  assert.match(res.payload.error, /60 words/);
});
