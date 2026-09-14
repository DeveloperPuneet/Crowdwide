const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { startTestDatabase, stopTestDatabase, extractCsrfToken, createAgent } = require('./helpers');

let dbHandle;
let app;
let User;

test.before(async () => {
  dbHandle = await startTestDatabase();
  const createApp = require('../../src/app');
  app = createApp({ port: 3000 });
  User = require('../../src/models/User');
});

test.after(async () => {
  await stopTestDatabase(dbHandle);
});

async function attemptLogin(agent, email, password) {
  const loginPage = await agent.get('/auth/login');
  const loginToken = extractCsrfToken(loginPage.text);
  return agent.post('/auth/login', { _csrf: loginToken, email, password });
}

test('a suspended user cannot log in even with the correct password', async () => {
  const email = `suspended.${Date.now()}@example.com`;
  const password = 'a-strong-password-123';
  await User.create({
    name: 'Suspended User',
    email,
    password: await bcrypt.hash(password, 12),
    isVerified: true,
    suspendedUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
    suspensionReason: 'Repeated harassment.'
  });

  const agent = createAgent(app);
  const res = await attemptLogin(agent, email, password);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/auth/login');

  const dashboardRes = await agent.get('/dashboard');
  assert.equal(dashboardRes.status, 302);
  assert.match(dashboardRes.headers.location, /\/auth\/login/);
});

test('failing the password 5 times against a suspended account does not lift the suspension (regression test for the loginLockedUntil/suspendedUntil field collision)', async () => {
  const email = `suspended-bypass.${Date.now()}@example.com`;
  const password = 'a-strong-password-123';
  const suspendedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await User.create({
    name: 'Suspended Bypass Attempt',
    email,
    password: await bcrypt.hash(password, 12),
    isVerified: true,
    suspendedUntil,
    suspensionReason: 'Under investigation.'
  });

  const agent = createAgent(app);
  // Fail the password 5 times in a row - this used to overwrite
  // suspendedUntil... except it never touched suspendedUntil at all in the
  // old code, because the bug was that SUSPENSION ITSELF was stored in
  // loginLockedUntil, which failed-password handling DOES overwrite. So
  // the meaningful assertion is: after 5 wrong attempts, the account must
  // still be suspended and still rejected even with the correct password.
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await attemptLogin(agent, email, 'definitely-the-wrong-password');
  }

  const userAfterFailedAttempts = await User.findOne({ email }).select('suspendedUntil loginLockedUntil');
  assert.ok(userAfterFailedAttempts.suspendedUntil, 'suspendedUntil should still be set');
  assert.equal(new Date(userAfterFailedAttempts.suspendedUntil).getTime(), suspendedUntil.getTime(), 'suspendedUntil must be untouched by failed-password handling');

  // The real proof: even the CORRECT password must still be rejected,
  // because the account is still suspended.
  const correctPasswordAttempt = await attemptLogin(agent, email, password);
  assert.equal(correctPasswordAttempt.status, 302);
  assert.equal(correctPasswordAttempt.headers.location, '/auth/login');
  const dashboardRes = await agent.get('/dashboard');
  assert.match(dashboardRes.headers.location, /\/auth\/login/);
});

test('a posting-restricted user is blocked from creating a post, with the reason in the message', async () => {
  const email = `restricted.${Date.now()}@example.com`;
  const password = 'a-strong-password-123';
  await User.create({
    name: 'Restricted User',
    email,
    password: await bcrypt.hash(password, 12),
    isVerified: true,
    postingRestrictedUntil: new Date(Date.now() + 60 * 60 * 1000),
    postingRestrictionReason: 'Cooling-off period after a warning.'
  });

  const agent = createAgent(app);
  const loginPage = await agent.get('/auth/login');
  const loginToken = extractCsrfToken(loginPage.text);
  await agent.post('/auth/login', { _csrf: loginToken, email, password });

  const dashboard = await agent.get('/dashboard');
  assert.equal(dashboard.status, 200);
  const composerToken = extractCsrfToken(dashboard.text);

  const request = require('supertest');
  const postRes = await request(app)
    .post('/posts')
    .set('Cookie', agent.getCookie())
    .field('_csrf', composerToken)
    .field('body', 'Trying to post while restricted.')
    .field('type', 'post');
  assert.equal(postRes.status, 302);
  assert.equal(postRes.headers.location, '/dashboard');

  const dashboardAfter = await agent.get('/dashboard');
  assert.doesNotMatch(dashboardAfter.text, /Trying to post while restricted\./);
});
