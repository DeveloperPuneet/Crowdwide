const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Post = require('../src/models/Post');
const { attachReplyPostCounts } = require('../src/services/replyPostCounts');

test('card repost counts use published reply posts rather than stale stored counters', async (t) => {
  const originalId = new mongoose.Types.ObjectId();
  const otherId = new mongoose.Types.ObjectId();
  const aggregate = t.mock.method(Post, 'aggregate', () => Promise.resolve([{ _id: originalId, count: 2 }]));
  const posts = [
    { _id: originalId, replyPostsCount: 0 },
    { _id: otherId, replyPostsCount: 7 }
  ];

  const counted = await attachReplyPostCounts(posts);

  assert.equal(counted[0].replyPostsCount, 2);
  assert.equal(counted[1].replyPostsCount, 0);
  assert.equal(posts[0].replyPostsCount, 0, 'the database result is shaped without mutating the input');
  assert.deepEqual(aggregate.mock.calls[0].arguments[0][0].$match, {
    replyTo: { $in: [originalId, otherId] },
    status: 'published'
  });
});
