const test = require('node:test');
const assert = require('node:assert/strict');

const Community = require('../src/models/Community');
const Post = require('../src/models/Post');
const { addActiveSponsoredPosts } = require('../src/services/feedService');

test('active sponsored posts are randomly placed between organic feed posts, including the owner', async (t) => {
  t.mock.method(Math, 'random', () => 0.999);
  const promotedPosts = [
    { _id: 'promoted-owned' },
    { _id: 'promoted-third' }
  ];
  t.mock.method(Community, 'find', () => ({ distinct: async () => [] }));
  t.mock.method(Post, 'find', (filter) => {
    assert.equal(filter.boostStatus, 'active');
    assert.deepEqual(filter.author.$nin, ['blocked-user', 'muted-user']);
    const query = {
      sort(sort) {
        assert.deepEqual(sort, { boostStartedAt: -1, createdAt: -1 });
        return this;
      },
      limit(limit) {
        assert.equal(limit, 30);
        return this;
      },
      select(fields) {
        assert.equal(fields, '_id');
        return this;
      },
      lean: async () => promotedPosts
    };
    return query;
  });

  const entries = [
    ...Array.from({ length: 16 }, (_, index) => ({
      id: `regular-${index}`,
      source: 'From your communities',
      lane: 'network'
    })),
    { id: 'promoted-third', source: 'From your communities', lane: 'network' }
  ];
  const viewer = {
    _id: 'owner-user',
    blockedUsers: ['blocked-user'],
    mutedUsers: ['muted-user']
  };
  const result = await addActiveSponsoredPosts(entries, viewer, 'for-you', Date.now());

  const sponsored = result.filter((entry) => entry.source === 'Sponsored');
  assert.equal(sponsored.length, 2);
  assert.ok(sponsored.some((entry) => entry.id === 'promoted-owned'));
  assert.ok(sponsored.some((entry) => entry.id === 'promoted-third'), 'a promoted post already in the organic page is shown as a sponsored placement');
  assert.ok(sponsored.every((entry) => entry.lane === 'sponsored'));
  assert.ok(result.indexOf(sponsored[0]) >= 3, 'first sponsored post follows at least three ordinary posts');
  assert.ok(result.indexOf(sponsored[1]) >= result.indexOf(sponsored[0]) + 5, 'sponsored placements are spaced apart');
  assert.equal(result.filter((entry) => entry.id.startsWith('regular-')).length, 16);
  assert.equal(result.filter((entry) => entry.id === 'promoted-third').length, 1, 'an organic promoted post is moved instead of duplicated');

  const communityFeed = await addActiveSponsoredPosts(entries, viewer, 'my-community', Date.now());
  assert.equal(communityFeed.filter((entry) => entry.source === 'Sponsored').length, 2, 'the My community feed also includes sponsored placements');
});
