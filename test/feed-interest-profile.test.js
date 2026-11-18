const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBehaviorInterestProfile } = require('../src/services/feedService');

test('behavior interests use observed post actions and exclude profile hashtags', () => {
  const profile = buildBehaviorInterestProfile({
    hashtags: ['written-topic'],
    liked: [{ hashtags: ['music'] }, { hashtags: ['music', 'travel'] }],
    reacted: [{ hashtags: ['music'] }],
    commented: [{ hashtags: ['travel'] }],
    saved: [{ hashtags: ['travel'] }],
    viewed: [{ hashtags: ['music'] }]
  });

  assert.ok(profile.interests.get('travel') > profile.interests.get('music'));
  assert.equal(profile.interests.has('written-topic'), false);
  assert.deepEqual(profile.evidence.get('music'), {
    likes: 2, reactions: 1, comments: 0, saves: 0, opens: 1
  });
  assert.deepEqual(profile.activity, {
    likes: 2, reactions: 1, comments: 1, saves: 1, opens: 1
  });
});
