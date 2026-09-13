const test = require('node:test');
const assert = require('node:assert/strict');

// isPushConfigured()/getPublicKey() cache their result once VAPID env vars
// are found, so this file deliberately tests the "not configured" behavior
// first, before any test sets the env vars.
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;

const push = require('../src/services/push');
const User = require('../src/models/User');
const webPush = require('web-push');

test('isPushConfigured/getPublicKey are falsy when VAPID keys are not set', () => {
  assert.equal(push.isPushConfigured(), false);
  assert.equal(push.getPublicKey(), null);
});

test('sendPushToUser is a no-op when push is not configured (no User lookup happens)', async (t) => {
  const findByIdCalls = t.mock.method(User, 'findById');
  await push.sendPushToUser('someUserId', { title: 'x', body: 'y' });
  assert.equal(findByIdCalls.mock.callCount(), 0);
});

test('configuring VAPID keys turns isPushConfigured/getPublicKey on', () => {
  process.env.VAPID_PUBLIC_KEY = 'test-public-key';
  process.env.VAPID_PRIVATE_KEY = 'test-private-key';
  t_mockSetVapidDetails();
  assert.equal(push.isPushConfigured(), true);
  assert.equal(push.getPublicKey(), 'test-public-key');
});

function t_mockSetVapidDetails() {
  // web-push validates the key format itself; stub it out so tests don't
  // need a real VAPID keypair.
  webPush.setVapidDetails = () => {};
}

test('sendPushToUser does nothing for a user who has not opted in', async (t) => {
  t.mock.method(User, 'findById', () => ({
    select: () => Promise.resolve({ pushNotificationsEnabled: false, pushSubscriptions: [{ endpoint: 'e1' }] })
  }));
  const sendCalls = t.mock.method(webPush, 'sendNotification', () => Promise.resolve());
  await push.sendPushToUser('u1', { title: 'x', body: 'y' });
  assert.equal(sendCalls.mock.callCount(), 0);
});

test('sendPushToUser does nothing for an opted-in user with no subscriptions', async (t) => {
  t.mock.method(User, 'findById', () => ({
    select: () => Promise.resolve({ pushNotificationsEnabled: true, pushSubscriptions: [] })
  }));
  const sendCalls = t.mock.method(webPush, 'sendNotification', () => Promise.resolve());
  await push.sendPushToUser('u1', { title: 'x', body: 'y' });
  assert.equal(sendCalls.mock.callCount(), 0);
});

test('sendPushToUser sends to every subscribed device', async (t) => {
  const subscriptions = [
    { endpoint: 'https://push.example/a', keys: { p256dh: 'p1', auth: 'a1' } },
    { endpoint: 'https://push.example/b', keys: { p256dh: 'p2', auth: 'a2' } }
  ];
  t.mock.method(User, 'findById', () => ({
    select: () => Promise.resolve({ pushNotificationsEnabled: true, pushSubscriptions: subscriptions })
  }));
  const sendCalls = t.mock.method(webPush, 'sendNotification', () => Promise.resolve());
  await push.sendPushToUser('u1', { title: 'Someone liked your post', body: 'x' });
  assert.equal(sendCalls.mock.callCount(), 2);
  const endpoints = sendCalls.mock.calls.map((call) => call.arguments[0].endpoint).sort();
  assert.deepEqual(endpoints, ['https://push.example/a', 'https://push.example/b']);
  // The payload sent to the push service should be the JSON-stringified
  // notification, not the raw object.
  const payload = JSON.parse(sendCalls.mock.calls[0].arguments[1]);
  assert.equal(payload.title, 'Someone liked your post');
});

test('sendPushToUser prunes subscriptions the push service reports as gone (404/410)', async (t) => {
  const subscriptions = [
    { endpoint: 'https://push.example/dead', keys: { p256dh: 'p1', auth: 'a1' } },
    { endpoint: 'https://push.example/alive', keys: { p256dh: 'p2', auth: 'a2' } }
  ];
  t.mock.method(User, 'findById', () => ({
    select: () => Promise.resolve({ pushNotificationsEnabled: true, pushSubscriptions: subscriptions })
  }));
  t.mock.method(webPush, 'sendNotification', (subscription) => {
    if (subscription.endpoint.endsWith('/dead')) {
      const error = new Error('Gone');
      error.statusCode = 410;
      return Promise.reject(error);
    }
    return Promise.resolve();
  });
  const updateCalls = t.mock.method(User, 'findByIdAndUpdate', () => Promise.resolve());
  await push.sendPushToUser('u1', { title: 'x', body: 'y' });
  assert.equal(updateCalls.mock.callCount(), 1);
  const [, update] = updateCalls.mock.calls[0].arguments;
  assert.deepEqual(update.$pull.pushSubscriptions.endpoint.$in, ['https://push.example/dead']);
});

test('sendPushToUser does not prune subscriptions on a non-404/410 error (e.g. a transient network failure)', async (t) => {
  const subscriptions = [{ endpoint: 'https://push.example/flaky', keys: { p256dh: 'p1', auth: 'a1' } }];
  t.mock.method(User, 'findById', () => ({
    select: () => Promise.resolve({ pushNotificationsEnabled: true, pushSubscriptions: subscriptions })
  }));
  t.mock.method(webPush, 'sendNotification', () => {
    const error = new Error('Temporary failure');
    error.statusCode = 500;
    return Promise.reject(error);
  });
  const updateCalls = t.mock.method(User, 'findByIdAndUpdate', () => Promise.resolve());
  const originalConsoleError = console.error;
  console.error = () => {}; // expected: the service logs and moves on
  await push.sendPushToUser('u1', { title: 'x', body: 'y' });
  console.error = originalConsoleError;
  assert.equal(updateCalls.mock.callCount(), 0);
});
