const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../src/models/User');
const { checkPostingRestriction } = require('../src/utils/postingRestriction');

function mockUser(t, fakeUser) {
  t.mock.method(User, 'findById', () => ({
    select: () => ({
      lean: () => Promise.resolve(fakeUser)
    })
  }));
}

test('checkPostingRestriction returns null when the user has no restriction', async (t) => {
  mockUser(t, { postingRestrictedUntil: null, postingRestrictionReason: '' });
  assert.equal(await checkPostingRestriction('u1'), null);
});

test('checkPostingRestriction returns null once the restriction has expired', async (t) => {
  mockUser(t, { postingRestrictedUntil: Date.now() - 1000, postingRestrictionReason: 'Spam' });
  assert.equal(await checkPostingRestriction('u1'), null);
});

test('checkPostingRestriction returns a message including the reason while restricted', async (t) => {
  mockUser(t, { postingRestrictedUntil: Date.now() + 60000, postingRestrictionReason: 'Repeated spam.' });
  const message = await checkPostingRestriction('u1');
  assert.match(message, /temporarily restricted from posting/);
  assert.match(message, /Repeated spam\./);
});

test('checkPostingRestriction returns a message even with no reason recorded', async (t) => {
  mockUser(t, { postingRestrictedUntil: Date.now() + 60000, postingRestrictionReason: '' });
  const message = await checkPostingRestriction('u1');
  assert.match(message, /temporarily restricted from posting/);
});

test('checkPostingRestriction returns null when the user cannot be found', async (t) => {
  mockUser(t, null);
  assert.equal(await checkPostingRestriction('missing'), null);
});
