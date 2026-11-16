const test = require('node:test');
const assert = require('node:assert/strict');
const { canSeeVoter } = require('../src/services/pollVoters');

const base = {
  voterId: 'voter',
  viewerId: 'viewer',
  pollAuthors: new Set(),
  viewerFollowing: new Set(),
  voterFollowsViewer: new Set(),
  voterPrivacy: 'public'
};

test('poll authors can see every voter, including private profiles', () => {
  assert.equal(canSeeVoter({ ...base, pollAuthors: new Set(['viewer']), voterPrivacy: 'followers' }), true);
});

test('other viewers can see voters who follow them or whom they follow', () => {
  assert.equal(canSeeVoter({ ...base, viewerFollowing: new Set(['voter']) }), true);
  assert.equal(canSeeVoter({ ...base, voterFollowsViewer: new Set(['voter']) }), true);
  assert.equal(canSeeVoter(base), false);
});

test('private voters are only visible to approved followers', () => {
  assert.equal(canSeeVoter({ ...base, voterPrivacy: 'followers', voterFollowsViewer: new Set(['voter']) }), false);
  assert.equal(canSeeVoter({ ...base, voterPrivacy: 'followers', viewerFollowing: new Set(['voter']) }), true);
});
