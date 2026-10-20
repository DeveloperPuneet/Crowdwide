const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../src/models/User');
const AccountEvent = require('../src/models/AccountEvent');
AccountEvent.create = async () => ({});
const settings = require('../src/controllers/settingsController');

const run = async (user, body) => {
  User.findById = async () => user;
  const req = { session: { user: { id: 'u1' } }, body, get: (h) => (h === 'X-Requested-With' ? 'XMLHttpRequest' : undefined) };
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await settings.setPanelPassword(req, res);
  return res;
};
const mod = () => ({ role: 'moderator', passwordSet: false, notificationPreferences: { security: false }, save: async function () { this.saved = true; } });

test('social-login moderator can set a panel password', async () => {
  const u = mod();
  const res = await run(u, { newPassword: 'longenough1', confirmPassword: 'longenough1' });
  assert.equal(res.body.ok, true);
  assert.equal(u.passwordSet, true);
  assert.notEqual(u.password, 'longenough1');
  assert.ok(u.saved);
});
test('mismatch, short passwords, regular users and users with a password are refused', async () => {
  assert.equal((await run(mod(), { newPassword: 'longenough1', confirmPassword: 'different11' })).code, 400);
  assert.equal((await run(mod(), { newPassword: 'short', confirmPassword: 'short' })).code, 400);
  assert.equal((await run({ ...mod(), role: 'user' }, { newPassword: 'longenough1', confirmPassword: 'longenough1' })).code, 400);
  assert.equal((await run({ ...mod(), passwordSet: true }, { newPassword: 'longenough1', confirmPassword: 'longenough1' })).code, 400);
});
