const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../src/models/User');
const countWords = require('../src/utils/wordCount');

test('profile bios are limited to 40 whitespace-separated words', () => {
  assert.equal(countWords(''), 0);
  assert.equal(countWords('  one\t two\nthree '), 3);

  const valid = new User({ name: 'Asha', email: 'asha@example.test', password: 'password', bio: Array(40).fill('word').join(' ') });
  assert.equal(valid.validateSync(), undefined);

  const invalid = new User({ name: 'Asha', email: 'asha@example.test', password: 'password', bio: Array(41).fill('word').join(' ') });
  assert.match(invalid.validateSync().errors.bio.message, /40 words/);
});
