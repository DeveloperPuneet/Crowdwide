const test = require('node:test');
const assert = require('node:assert/strict');
const { COMMUNITY_CATEGORIES, normalizeCommunityCategory } = require('../src/utils/communityCategories');

test('community category options include the requested categories', () => {
  const values = COMMUNITY_CATEGORIES.map(({ value }) => value);
  assert.ok(values.includes('general'));
  assert.ok(values.includes('community'));
  assert.ok(values.includes('technology'));
  assert.ok(values.includes('social networking'));
  assert.ok(values.includes('chatting'));
});

test('community categories are normalized and legacy values can be preserved', () => {
  assert.equal(normalizeCommunityCategory(' Technology '), 'technology');
  assert.equal(normalizeCommunityCategory('Old custom category', 'Old custom category'), 'old custom category');
  assert.equal(normalizeCommunityCategory('Unrecognized category', 'Old custom category'), null);
});
