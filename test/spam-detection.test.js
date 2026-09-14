const test = require('node:test');
const assert = require('node:assert/strict');
const Post = require('../src/models/Post');
const { isRepeatPost } = require('../src/utils/spamDetection');

function mockFindOne(t, result) {
  return t.mock.method(Post, 'findOne', () => ({
    select: () => ({
      lean: () => Promise.resolve(result)
    })
  }));
}

test('isRepeatPost returns false for empty body without querying the database', async (t) => {
  const findOneCalls = t.mock.method(Post, 'findOne');
  assert.equal(await isRepeatPost(Post, 'u1', ''), false);
  assert.equal(findOneCalls.mock.callCount(), 0);
});

test('isRepeatPost returns true when a matching recent post exists', async (t) => {
  mockFindOne(t, { _id: 'p1' });
  assert.equal(await isRepeatPost(Post, 'u1', 'Buy my product now!'), true);
});

test('isRepeatPost returns false when no matching recent post exists', async (t) => {
  mockFindOne(t, null);
  assert.equal(await isRepeatPost(Post, 'u1', 'A genuinely new thought.'), false);
});

test('isRepeatPost queries only this author, this exact body, non-draft posts, within the time window', async (t) => {
  const findOneCalls = mockFindOne(t, null);
  await isRepeatPost(Post, 'u1', 'Hello world', 5 * 60 * 1000);
  const query = findOneCalls.mock.calls[0].arguments[0];
  assert.equal(query.author, 'u1');
  assert.equal(query.body, 'Hello world');
  assert.deepEqual(query.status, { $ne: 'draft' });
  assert.ok(query.createdAt.$gt instanceof Date);
  assert.ok(query.createdAt.$gt.getTime() <= Date.now() - 5 * 60 * 1000 + 1000);
});
