const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../src/models/User');
const Post = require('../src/models/Post');
const { toggleBookmark, createPostCollection, toggleAma } = require('../src/controllers/interactionController');

const objectIdArray = (values = []) => {
  const result = values.slice();
  result.addToSet = (value) => { if (!result.some((item) => String(item) === String(value))) result.push(value); };
  result.pull = (value) => {
    for (let index = result.length - 1; index >= 0; index -= 1) {
      if (String(result[index]) === String(value)) result.splice(index, 1);
    }
  };
  return result;
};

const collection = (id, name, postIds = []) => ({
  _id: id,
  name,
  postIds: objectIdArray(postIds),
  addToSet() {},
  save() {}
});

const viewer = (postIds = ['p1']) => {
  const collections = [collection('c1', 'Reading list', ['p1'])];
  collections.id = (id) => collections.find((entry) => String(entry._id) === String(id));
  return {
    bookmarks: objectIdArray(postIds),
    postCollections: collections,
    async save() { this.saved = true; }
  };
};

const response = () => ({
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.payload = payload; }
});

const request = (body) => ({
  params: { id: 'p1' },
  session: { user: { id: 'u1' } },
  body,
  get: (header) => header === 'X-Requested-With' ? 'XMLHttpRequest' : null
});

function mockPost(t) {
  t.mock.method(Post, 'findById', () => ({
    select() { return this; },
    lean: async () => ({ _id: 'p1', author: 'u2', status: 'published', community: null })
  }));
}

test('removing a post from one folder keeps it saved in the main library', async (t) => {
  const user = viewer();
  t.mock.method(User, 'findById', async () => user);
  mockPost(t);
  const res = response();

  await toggleBookmark({ ...request({ collectionId: 'c1', add: 'false' }), params: { id: 'p1' } }, res);

  assert.equal(user.saved, true);
  assert.deepEqual(Array.from(user.bookmarks), ['p1']);
  assert.deepEqual(Array.from(user.postCollections[0].postIds), []);
  assert.deepEqual(res.payload, {
    ok: true, bookmarked: true, collectionIds: [], collections: [{ id: 'c1', name: 'Reading list', count: 0 }],
    collectionId: 'c1', inCollection: false, collectionCount: 0
  });
});

test('creating a collection from a post saves it into that collection without a redirect', async (t) => {
  const user = viewer();
  user.postCollections.splice(0, user.postCollections.length);
  user.postCollections.id = (id) => user.postCollections.find((entry) => String(entry._id) === String(id));
  t.mock.method(User, 'findById', async () => user);
  mockPost(t);
  const res = response();

  await createPostCollection({ ...request({ name: 'Research', postId: 'p1' }), params: {} }, res);

  assert.equal(user.saved, true);
  assert.deepEqual(Array.from(user.bookmarks), ['p1']);
  assert.equal(user.postCollections[0].name, 'Research');
  assert.deepEqual(user.postCollections[0].postIds.map(String), ['p1']);
  assert.equal(res.payload.collection.name, 'Research');
  assert.equal(res.payload.bookmarked, true);
});

test('restarting an AMA refreshes its start time and clears the previous end time', async (t) => {
  const post = {
    author: 'u1',
    ama: { enabled: false, startedAt: new Date('2025-01-01'), endedAt: new Date('2025-01-02') },
    async save() { this.saved = true; }
  };
  t.mock.method(Post, 'findById', async () => post);
  const res = response();

  await toggleAma({ ...request({ enabled: 'true' }), params: { id: 'p1' } }, res);

  assert.equal(post.saved, true);
  assert.equal(post.ama.enabled, true);
  assert.ok(post.ama.startedAt > new Date('2025-01-02'));
  assert.equal(post.ama.endedAt, undefined);
  assert.deepEqual(res.payload, { ok: true, amaEnabled: true });
});
