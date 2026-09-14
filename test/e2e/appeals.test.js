const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { startTestDatabase, stopTestDatabase, extractCsrfToken, createAgent } = require('./helpers');

let dbHandle;
let app;
let User;
let Appeal;

test.before(async () => {
  dbHandle = await startTestDatabase();
  const createApp = require('../../src/app');
  app = createApp({ port: 3000 });
  User = require('../../src/models/User');
  Appeal = require('../../src/models/Appeal');
});

test.after(async () => {
  await stopTestDatabase(dbHandle);
});

async function loginAs(agent, email, password) {
  const loginPage = await agent.get('/auth/login');
  const loginToken = extractCsrfToken(loginPage.text);
  return agent.post('/auth/login', { _csrf: loginToken, email, password });
}

test('a suspended user can appeal from the public page, and regains access once an admin approves it', async () => {
  const email = `appeal-flow.${Date.now()}@example.com`;
  const password = 'a-strong-password-123';
  const suspendedUser = await User.create({
    name: 'Appealing User',
    email,
    password: await bcrypt.hash(password, 12),
    isVerified: true,
    suspendedUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
    suspensionReason: 'Under review.'
  });

  // Confirm they really are locked out first.
  const suspendedAgent = createAgent(app);
  const blockedAttempt = await loginAs(suspendedAgent, email, password);
  assert.equal(blockedAttempt.status, 302);
  assert.equal(blockedAttempt.headers.location, '/auth/login');

  // Submit the public appeal (no login required/possible).
  const appealPage = await suspendedAgent.get('/auth/appeal');
  assert.equal(appealPage.status, 200);
  const appealToken = extractCsrfToken(appealPage.text);
  const appealRes = await suspendedAgent.post('/auth/appeal', {
    _csrf: appealToken,
    email,
    message: 'This was a misunderstanding, please review my account.'
  });
  assert.equal(appealRes.status, 302);

  const appeal = await Appeal.findOne({ user: suspendedUser._id, actionType: 'suspension' });
  assert.ok(appeal, 'an appeal record should have been created');
  assert.equal(appeal.status, 'pending');

  // An admin logs in and approves the appeal.
  const adminEmail = `appeal-admin.${Date.now()}@example.com`;
  const adminPassword = 'a-strong-password-123';
  await User.create({ name: 'Reviewing Admin', email: adminEmail, password: await bcrypt.hash(adminPassword, 12), isVerified: true, role: 'admin' });

  const adminAgent = createAgent(app);
  await loginAs(adminAgent, adminEmail, adminPassword);
  const accessPage = await adminAgent.get('/admin/access');
  const accessToken = extractCsrfToken(accessPage.text);
  await adminAgent.post('/admin/access', { _csrf: accessToken, password: adminPassword, returnTo: '/admin' });

  const adminPage = await adminAgent.get('/admin');
  assert.equal(adminPage.status, 200);
  assert.match(adminPage.text, /This was a misunderstanding/);
  const resolveToken = extractCsrfToken(adminPage.text);
  const resolveRes = await adminAgent.post(`/admin/appeals/${appeal._id}`, { _csrf: resolveToken, decision: 'approve', note: 'Reviewed, lifting suspension.' });
  assert.equal(resolveRes.status, 302);

  const updatedAppeal = await Appeal.findById(appeal._id);
  assert.equal(updatedAppeal.status, 'approved');

  const updatedUser = await User.findById(suspendedUser._id).select('suspendedUntil suspensionReason');
  assert.equal(updatedUser.suspendedUntil, null);
  assert.equal(updatedUser.suspensionReason, '');

  // The user can now log in normally.
  const freshAgent = createAgent(app);
  const successfulLogin = await loginAs(freshAgent, email, password);
  assert.equal(successfulLogin.status, 302);
  assert.equal(successfulLogin.headers.location, '/dashboard');
  const dashboard = await freshAgent.get('/dashboard');
  assert.equal(dashboard.status, 200);
});

test('denying an appeal leaves the suspension in place', async () => {
  const email = `appeal-denied.${Date.now()}@example.com`;
  const password = 'a-strong-password-123';
  const suspendedUser = await User.create({
    name: 'Denied Appeal User',
    email,
    password: await bcrypt.hash(password, 12),
    isVerified: true,
    suspendedUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
    suspensionReason: 'Serious violation.'
  });

  const appeal = await Appeal.create({ user: suspendedUser._id, actionType: 'suspension', reasonSnapshot: 'Serious violation.', message: 'I disagree.' });

  const adminEmail = `appeal-admin-deny.${Date.now()}@example.com`;
  const adminPassword = 'a-strong-password-123';
  await User.create({ name: 'Denying Admin', email: adminEmail, password: await bcrypt.hash(adminPassword, 12), isVerified: true, role: 'admin' });

  const adminAgent = createAgent(app);
  await loginAs(adminAgent, adminEmail, adminPassword);
  const accessPage = await adminAgent.get('/admin/access');
  const accessToken = extractCsrfToken(accessPage.text);
  await adminAgent.post('/admin/access', { _csrf: accessToken, password: adminPassword, returnTo: '/admin' });
  const adminPage = await adminAgent.get('/admin');
  const resolveToken = extractCsrfToken(adminPage.text);
  await adminAgent.post(`/admin/appeals/${appeal._id}`, { _csrf: resolveToken, decision: 'deny', note: 'Suspension stands.' });

  const updatedUser = await User.findById(suspendedUser._id).select('suspendedUntil');
  assert.ok(updatedUser.suspendedUntil, 'suspension should still be in place after a denied appeal');

  const stillBlockedAgent = createAgent(app);
  const stillBlocked = await loginAs(stillBlockedAgent, email, password);
  assert.equal(stillBlocked.headers.location, '/auth/login');
});
