const test = require('node:test');
const assert = require('node:assert/strict');
const Community = require('../src/models/Community');
const { getRestrictedCommunityIds } = require('../src/utils/communityPrivacy');

test('getRestrictedCommunityIds queries only private communities the user has not joined', async (t) => {
  const distinctCalls = t.mock.method(Community, 'find', () => ({ distinct: () => Promise.resolve(['c1', 'c2']) }));
  const result = await getRestrictedCommunityIds('u1');
  assert.deepEqual(result, ['c1', 'c2']);
  assert.deepEqual(distinctCalls.mock.calls[0].arguments[0], { isPrivate: true, members: { $ne: 'u1' } });
});

test('getRestrictedCommunityIds restricts every private community for an anonymous/no-userId viewer', async (t) => {
  const distinctCalls = t.mock.method(Community, 'find', () => ({ distinct: () => Promise.resolve(['c1', 'c2', 'c3']) }));
  const result = await getRestrictedCommunityIds(null);
  assert.deepEqual(result, ['c1', 'c2', 'c3']);
  assert.deepEqual(distinctCalls.mock.calls[0].arguments[0], { isPrivate: true });
});
