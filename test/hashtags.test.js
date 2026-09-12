const test = require('node:test');
const assert = require('node:assert/strict');
const { extractHashtags, parseHashtagList } = require('../src/utils/hashtags');

test('extractHashtags returns unique lowercase tags in input order', () => {
  assert.deepEqual(extractHashtags('Build #Makers with #makers and #Design.'), ['makers', 'design']);
});

test('parseHashtagList normalizes separators and removes invalid tags', () => {
  assert.deepEqual(parseHashtagList('#Woodworking, diy makers! x'), ['woodworking', 'diy', 'makers']);
});
