const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../src/models/User');
let lastQuery;
User.find = (q) => { lastQuery = q; return { distinct: async () => ['p1'] }; };
User.findById = () => ({ select: () => ({ lean: async () => ({ following: ['f1'] }) }) });
const { getHiddenAuthorIds, canSeeProfileDetails } = require('../src/utils/profilePrivacy');

test('hidden authors exclude the viewer and people they follow', async () => {
  const ids = await getHiddenAuthorIds('v1');
  assert.deepEqual(ids, ['p1']);
  assert.equal(lastQuery.privacy, 'followers');
  assert.deepEqual(lastQuery._id.$nin.sort(), ['f1', 'v1']);
});
test('signed-out visitors have every private profile hidden', async () => {
  await getHiddenAuthorIds(null);
  assert.equal(lastQuery._id, undefined);
});
test('private profile details: self, approved followers and staff only', () => {
  const p = { _id: 'a', privacy: 'followers' };
  assert.equal(canSeeProfileDetails({ profileUser: p, viewerId: 'b', viewerFollowing: [] }), false);
  assert.equal(canSeeProfileDetails({ profileUser: p, viewerId: 'b', viewerFollowing: ['a'] }), true);
  assert.equal(canSeeProfileDetails({ profileUser: p, viewerId: 'a' }), true);
  assert.equal(canSeeProfileDetails({ profileUser: p, viewerId: 'b', viewerRole: 'moderator' }), true);
  assert.equal(canSeeProfileDetails({ profileUser: { _id: 'a', privacy: 'public' }, viewerId: 'b' }), true);
});
