const test = require('node:test');
const assert = require('node:assert/strict');
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

test('signup -> verify -> login -> create a post shows up on the dashboard', async () => {
  const agent = createAgent(app);
  const email = `pat.${Date.now()}@example.com`;

  // 1. Load the registration page for a session + csrf token.
  const registerPage = await agent.get('/auth/register');
  assert.equal(registerPage.status, 200);
  const registerToken = extractCsrfToken(registerPage.text);
  const captchaMatch = registerPage.text.match(/what is (\d+) \+ (\d+)\?/);
  assert.ok(captchaMatch, 'registration page should render a captcha challenge');
  const captchaAnswer = Number(captchaMatch[1]) + Number(captchaMatch[2]);

  // 2. Register. The app emails a 6-digit verification code (or console-logs
  // it, since no MAIL_* env vars are set in tests) -- read it back from the
  // database instead of parsing stdout.
  const registerRes = await agent.post('/auth/register', {
    _csrf: registerToken,
    name: 'Pat Example',
    email,
    password: 'a-strong-password-123',
    captchaAnswer
  });
  assert.equal(registerRes.status, 302);
  assert.match(registerRes.headers.location, /\/auth\/verify/);

  const pendingUser = await User.findOne({ email }).select('verificationCode isVerified');
  assert.ok(pendingUser, 'user should exist after registering');
  assert.equal(pendingUser.isVerified, false);
  assert.ok(pendingUser.verificationCode, 'a verification code should have been generated');

  // 3. Verify with that code.
  const verifyPage = await agent.get(`/auth/verify?email=${encodeURIComponent(email)}`);
  const verifyToken = extractCsrfToken(verifyPage.text);
  const verifyRes = await agent.post('/auth/verify', {
    _csrf: verifyToken,
    email,
    code: pendingUser.verificationCode
  });
  assert.equal(verifyRes.status, 302);
  assert.equal(verifyRes.headers.location, '/dashboard');

  const verifiedUser = await User.findOne({ email }).select('isVerified');
  assert.equal(verifiedUser.isVerified, true);

  // Verifying logs the user in directly (establishSession), so the
  // dashboard should now be reachable in the same session.
  const dashboardAfterVerify = await agent.get('/dashboard');
  assert.equal(dashboardAfterVerify.status, 200);

  // 4. Create a post through the real multipart composer form, exactly as
  // the browser does (the form uses enctype="multipart/form-data").
  const composerToken = extractCsrfToken(dashboardAfterVerify.text);
  const request = require('supertest');
  const postRes = await request(app)
    .post('/posts')
    .set('Cookie', agent.getCookie())
    .field('_csrf', composerToken)
    .field('body', 'Hello from the automated e2e test!')
    .field('type', 'post');
  assert.equal(postRes.status, 302);
  assert.equal(postRes.headers.location, '/dashboard');

  // 5. Confirm it's visible on the dashboard feed.
  const dashboardAfterPost = await agent.get('/dashboard');
  assert.equal(dashboardAfterPost.status, 200);
  assert.match(dashboardAfterPost.text, /Hello from the automated e2e test!/);
});

test('logging in with the wrong password does not create a session', async () => {
  const agent = createAgent(app);
  const email = `wrongpass.${Date.now()}@example.com`;

  // Create and verify a user directly against the model, bypassing the HTTP
  // flow, since this test only cares about login behavior.
  const bcrypt = require('bcryptjs');
  await User.create({
    name: 'Wrong Pass',
    email,
    password: await bcrypt.hash('the-real-password', 12),
    isVerified: true
  });

  const loginPage = await agent.get('/auth/login');
  const loginToken = extractCsrfToken(loginPage.text);
  const loginRes = await agent.post('/auth/login', {
    _csrf: loginToken,
    email,
    password: 'not-the-real-password'
  });
  assert.equal(loginRes.status, 302);
  assert.equal(loginRes.headers.location, '/auth/login');

  const dashboardRes = await agent.get('/dashboard');
  // requireAuth should bounce an unauthenticated visitor away from /dashboard.
  assert.equal(dashboardRes.status, 302);
  assert.match(dashboardRes.headers.location, /\/auth\/login/);
});
