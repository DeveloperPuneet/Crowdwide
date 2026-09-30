const test = require('node:test');
const assert = require('node:assert/strict');
const { toggleReaction, REACTION_EMOJIS, summarize } = require('../src/utils/reactions');

test('an unsupported emoji is rejected', () => {
  assert.equal(toggleReaction([], '🍕', 'u1'), null);
});

test('a first reaction from a user is added, not toggled off', () => {
  const result = toggleReaction([], '👍', 'u1');
  assert.equal(result.reacted, true);
  assert.deepEqual(result.reactions, [{ emoji: '👍', users: ['u1'] }]);
  assert.deepEqual(result.summary, [{ emoji: '👍', count: 1, reacted: true }]);
});

test('reacting again with the same emoji removes it, and an empty entry is dropped', () => {
  const first = toggleReaction([], '❤️', 'u1');
  const second = toggleReaction(first.reactions, '❤️', 'u1');
  assert.equal(second.reacted, false);
  assert.deepEqual(second.reactions, []);
  assert.deepEqual(second.summary, []);
});

test('a user can react with more than one emoji independently', () => {
  const first = toggleReaction([], '👍', 'u1');
  const second = toggleReaction(first.reactions, '😂', 'u1');
  assert.equal(second.reactions.length, 2);
  const summary = summarize(second.reactions, 'u1');
  assert.deepEqual(summary.sort((a, b) => a.emoji.localeCompare(b.emoji)), [
    { emoji: '😂', count: 1, reacted: true },
    { emoji: '👍', count: 1, reacted: true }
  ].sort((a, b) => a.emoji.localeCompare(b.emoji)));
});

test('two different users on the same emoji both count, and each sees their own reacted flag', () => {
  const afterUser1 = toggleReaction([], '🔥', 'u1');
  const afterUser2 = toggleReaction(afterUser1.reactions, '🔥', 'u2');
  assert.equal(afterUser2.reactions[0].users.length, 2);
  assert.deepEqual(summarize(afterUser2.reactions, 'u1'), [{ emoji: '🔥', count: 2, reacted: true }]);
  assert.deepEqual(summarize(afterUser2.reactions, 'u3'), [{ emoji: '🔥', count: 2, reacted: false }]);
});

test('REACTION_EMOJIS is a fixed, non-empty set', () => {
  assert.ok(Array.isArray(REACTION_EMOJIS) && REACTION_EMOJIS.length >= 6);
});
