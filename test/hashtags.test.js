const test = require('node:test');
const assert = require('node:assert/strict');
const { extractHashtags, parseHashtagList } = require('../src/utils/hashtags');
const Post = require('../src/models/Post');
const { getHashtagSuggestions } = require('../src/services/discovery');

test('extractHashtags returns unique lowercase tags in input order', () => {
  assert.deepEqual(extractHashtags('Build #Makers with #makers and #Design.'), ['makers', 'design']);
});

test('parseHashtagList normalizes separators and removes invalid tags', () => {
  assert.deepEqual(parseHashtagList('#Woodworking, diy makers! x'), ['woodworking', 'diy', 'makers']);
});

test('hashtag suggestions search every published tag matching the prefix, not only global top tags', async (t) => {
  const suggestions = [{ tag: 'newtopic', posts: 1 }, { tag: 'news', posts: 4 }];
  let pipeline;
  t.mock.method(Post, 'aggregate', async (value) => {
    pipeline = value;
    return suggestions;
  });

  assert.deepEqual(await getHashtagSuggestions('New!'), suggestions);
  assert.deepEqual(pipeline[0].$match, { status: 'published', hashtags: { $regex: /^new/ } });
  assert.equal(pipeline[1].$unwind, '$hashtags');
  assert.deepEqual(pipeline[2].$match, { hashtags: { $regex: /^new/ } });
  assert.deepEqual(pipeline[3].$group, { _id: '$hashtags', posts: { $sum: 1 }, latest: { $max: '$createdAt' } });
  assert.deepEqual(pipeline[4].$sort, { posts: -1, latest: -1, _id: 1 });
  assert.equal(pipeline[5].$limit, 8);
});

test('hashtag suggestions skip short prefixes and normalize to safe tag characters', async (t) => {
  const aggregate = t.mock.method(Post, 'aggregate', async () => []);
  assert.deepEqual(await getHashtagSuggestions('x'), []);
  assert.equal(aggregate.mock.callCount(), 0);

  await getHashtagSuggestions('Fresh_tag!');
  assert.equal(aggregate.mock.callCount(), 1);
  assert.deepEqual(aggregate.mock.calls[0].arguments[0][0].$match.hashtags.$regex, /^fresh_tag/);
});
