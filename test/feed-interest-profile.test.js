const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildBehaviorInterestProfile,
  interactionWeight,
  DEFAULT_INTERACTION_HALF_LIFE_DAYS
} = require('../src/services/feedService');

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
    likes: 2, reactions: 1, comments: 0, saves: 0, opens: 1, pollVotes: 0
  });
  assert.deepEqual(profile.activity, {
    likes: 2, reactions: 1, comments: 1, saves: 1, opens: 1, pollVotes: 0
  });
});

test('interaction weights decay by half-life and recent engagement revives an older topic', () => {
  const now = Date.parse('2026-09-20T12:00:00Z');
  const halfLifeMs = DEFAULT_INTERACTION_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000;
  assert.equal(interactionWeight('like', new Date(now - halfLifeMs), now, DEFAULT_INTERACTION_HALF_LIFE_DAYS), 0.5);
  assert.equal(interactionWeight('save', new Date(now), now, DEFAULT_INTERACTION_HALF_LIFE_DAYS), 2.5);

  const oldInterest = { hashtags: ['music'] };
  const currentInterest = { hashtags: ['coding'] };
  const atHalfLife = buildBehaviorInterestProfile({
    now,
    interactions: [
      { type: 'like', post: oldInterest, occurredAt: new Date(now - halfLifeMs) },
      { type: 'like', post: currentInterest, occurredAt: new Date(now) }
    ]
  });
  assert.ok(atHalfLife.interests.get('coding') > atHalfLife.interests.get('music'));
  const onlyOldInterest = buildBehaviorInterestProfile({
    now,
    interactions: [{ type: 'like', post: oldInterest, occurredAt: new Date(now - halfLifeMs) }]
  });
  assert.ok(onlyOldInterest.interests.get('music') < 1);
  assert.equal(buildBehaviorInterestProfile({
    now,
    interactions: [{ type: 'like', post: oldInterest, occurredAt: new Date(now) }]
  }).interests.get('music'), 1);

  const renewedInterest = buildBehaviorInterestProfile({
    now,
    interactions: [
      { type: 'like', post: oldInterest, occurredAt: new Date(now - halfLifeMs) },
      { type: 'like', post: oldInterest, occurredAt: new Date(now) },
      { type: 'like', post: currentInterest, occurredAt: new Date(now) }
    ]
  });
  assert.ok(renewedInterest.interests.get('music') > renewedInterest.interests.get('coding'));
});
