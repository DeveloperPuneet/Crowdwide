const test = require('node:test');
const assert = require('node:assert/strict');
const Community = require('../src/models/Community');
const { canAccessPost } = require('../src/controllers/interactionController');

test('canAccessPost returns false for a null/missing post', async () => {
  assert.equal(await canAccessPost(null, 'u1'), false);
});

test('canAccessPost allows a published post with no community, without querying Community at all', async (t) => {
  const existsCalls = t.mock.method(Community, 'exists');
  const result = await canAccessPost({ status: 'published', author: 'u2', community: null }, 'u1');
  assert.equal(result, true);
  assert.equal(existsCalls.mock.callCount(), 0);
});

test('canAccessPost blocks a draft post for anyone but its author', async () => {
  const result = await canAccessPost({ status: 'draft', author: 'u2', community: null }, 'u1');
  assert.equal(result, false);
});

test('canAccessPost allows a draft post for its own author', async () => {
  const result = await canAccessPost({ status: 'draft', author: 'u1', community: null }, 'u1');
  assert.equal(result, true);
});

test('canAccessPost blocks a scheduled post for anyone but its author', async () => {
  const result = await canAccessPost({ status: 'scheduled', author: 'u2', community: null }, 'u1');
  assert.equal(result, false);
});

test('canAccessPost blocks a post in a private community the viewer has not joined (the core fix)', async (t) => {
  t.mock.method(Community, 'exists', () => Promise.resolve(true));
  const result = await canAccessPost({ status: 'published', author: 'u2', community: 'c1' }, 'u1');
  assert.equal(result, false);
});

test('canAccessPost allows a post in a private community the viewer HAS joined', async (t) => {
  // Community.exists({ isPrivate: true, members: { $ne: userId } }) correctly
  // resolves falsy when the viewer IS in members - simulate that here.
  t.mock.method(Community, 'exists', () => Promise.resolve(null));
  const result = await canAccessPost({ status: 'published', author: 'u2', community: 'c1' }, 'u1');
  assert.equal(result, true);
});

test('canAccessPost allows a post in a public (non-private) community for a non-member', async (t) => {
  t.mock.method(Community, 'exists', () => Promise.resolve(null)); // isPrivate:true condition never matches a public community
  const result = await canAccessPost({ status: 'published', author: 'u2', community: 'c1' }, 'u1');
  assert.equal(result, true);
});

test('canAccessPost blocks an anonymous (logged-out) viewer from any private-community post', async (t) => {
  const existsCalls = t.mock.method(Community, 'exists', ({ members }) => {
    // members: { $ne: undefined } should behave as "always true" for a
    // real private community, since no member ID ever equals undefined.
    assert.deepEqual(members, { $ne: undefined });
    return Promise.resolve(true);
  });
  const result = await canAccessPost({ status: 'published', author: 'u2', community: 'c1' }, undefined);
  assert.equal(result, false);
  assert.equal(existsCalls.mock.callCount(), 1);
});

test('canAccessPost checks community using the exact community/isPrivate/members query shape', async (t) => {
  const existsCalls = t.mock.method(Community, 'exists', () => Promise.resolve(false));
  await canAccessPost({ status: 'published', author: 'u2', community: 'c1' }, 'u1');
  assert.deepEqual(existsCalls.mock.calls[0].arguments[0], { _id: 'c1', isPrivate: true, members: { $ne: 'u1' } });
});
