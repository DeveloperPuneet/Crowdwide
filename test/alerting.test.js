const test = require('node:test');
const assert = require('node:assert/strict');

delete process.env.ADMIN_ALERT_EMAIL;
const alerting = require('../src/services/alerting');
const mailer = require('../src/services/mailer');

test('isConfigured is false when ADMIN_ALERT_EMAIL is not set', () => {
  delete process.env.ADMIN_ALERT_EMAIL;
  assert.equal(alerting.isConfigured(), false);
});

test('alertOnCriticalError does nothing when not configured (no mail attempted)', async (t) => {
  delete process.env.ADMIN_ALERT_EMAIL;
  const sendCalls = t.mock.method(mailer, 'sendSecurityAlert', () => Promise.resolve());
  await alerting.alertOnCriticalError(new Error('boom'), { route: '/dashboard' });
  assert.equal(sendCalls.mock.callCount(), 0);
});

test('isConfigured is true once ADMIN_ALERT_EMAIL is set', () => {
  process.env.ADMIN_ALERT_EMAIL = 'oncall@example.com';
  assert.equal(alerting.isConfigured(), true);
});

test('alertOnCriticalError sends one alert email for a fresh error signature', async (t) => {
  process.env.ADMIN_ALERT_EMAIL = 'oncall@example.com';
  const sendCalls = t.mock.method(mailer, 'sendSecurityAlert', () => Promise.resolve());
  await alerting.alertOnCriticalError(new Error(`unique error ${Date.now()}`), { route: '/checkout' });
  assert.equal(sendCalls.mock.callCount(), 1);
  assert.equal(sendCalls.mock.calls[0].arguments[0].email, 'oncall@example.com');
  assert.match(sendCalls.mock.calls[0].arguments[1].subject, /Crowdwide error/);
});

test('alertOnCriticalError does not send a second alert for the same error within the cooldown window', async (t) => {
  process.env.ADMIN_ALERT_EMAIL = 'oncall@example.com';
  const sendCalls = t.mock.method(mailer, 'sendSecurityAlert', () => Promise.resolve());
  const message = `repeat-error-${Date.now()}`;
  await alerting.alertOnCriticalError(new Error(message), { route: '/checkout' });
  await alerting.alertOnCriticalError(new Error(message), { route: '/checkout' });
  await alerting.alertOnCriticalError(new Error(message), { route: '/checkout' });
  assert.equal(sendCalls.mock.callCount(), 1);
});

test('alertOnCriticalError treats the same message on a different route as a different signature', async (t) => {
  process.env.ADMIN_ALERT_EMAIL = 'oncall@example.com';
  const sendCalls = t.mock.method(mailer, 'sendSecurityAlert', () => Promise.resolve());
  const message = `cross-route-error-${Date.now()}`;
  await alerting.alertOnCriticalError(new Error(message), { route: '/route-a' });
  await alerting.alertOnCriticalError(new Error(message), { route: '/route-b' });
  assert.equal(sendCalls.mock.callCount(), 2);
});

test('alertOnCriticalError never throws even if sending the alert itself fails', async (t) => {
  process.env.ADMIN_ALERT_EMAIL = 'oncall@example.com';
  t.mock.method(mailer, 'sendSecurityAlert', () => Promise.reject(new Error('mail service down')));
  await assert.doesNotReject(alerting.alertOnCriticalError(new Error(`will-fail-${Date.now()}`), { route: '/x' }));
});
