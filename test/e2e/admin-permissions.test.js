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

async function loginAs(agent, email, password) {
  const loginPage = await agent.get('/auth/login');
  const loginToken = extractCsrfToken(loginPage.text);
  return agent.post('/auth/login', { _csrf: loginToken, email, password });
}

test('an unauthenticated visitor is redirected away from /admin', async () => {
  const agent = createAgent(app);
  const res = await agent.get('/admin');
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /\/auth\/login/);
});

test('a signed-in "user" role gets a 403 on /admin, never reaching the panel password gate', async () => {
  const email = `plainuser.${Date.now()}@example.com`;
  const password = 'a-strong-password-123';
  await User.create({ name: 'Plain User', email, password: await bcrypt.hash(password, 12), isVerified: true, role: 'user' });

  const agent = createAgent(app);
  const loginRes = await loginAs(agent, email, password);
  assert.equal(loginRes.status, 302);
  assert.equal(loginRes.headers.location, '/dashboard');

  const adminRes = await agent.get('/admin');
  assert.equal(adminRes.status, 403);
});

test('a "moderator" role is also blocked from the admin-only panel', async () => {
  const email = `moduser.${Date.now()}@example.com`;
  const password = 'a-strong-password-123';
  await User.create({ name: 'Mod User', email, password: await bcrypt.hash(password, 12), isVerified: true, role: 'moderator' });

  const agent = createAgent(app);
  await loginAs(agent, email, password);
  const adminRes = await agent.get('/admin');
  assert.equal(adminRes.status, 403);
});

test('an "admin" role must confirm their password before reaching the panel, then gets in', async () => {
  const email = `admin.${Date.now()}@example.com`;
  const password = 'a-strong-password-123';
  await User.create({ name: 'Boss Admin', email, password: await bcrypt.hash(password, 12), isVerified: true, role: 'admin' });

  const agent = createAgent(app);
  const loginRes = await loginAs(agent, email, password);
  assert.equal(loginRes.status, 302);

  // First hit: role check passes, but the panel password hasn't been
  // confirmed yet this session, so requirePanelPassword should bounce us
  // to the re-authentication page instead of a 403.
  const firstAttempt = await agent.get('/admin');
  assert.equal(firstAttempt.status, 302);
  assert.equal(firstAttempt.headers.location, '/admin/access?returnTo=/admin');

  const accessPage = await agent.get('/admin/access');
  assert.equal(accessPage.status, 200);
  const accessToken = extractCsrfToken(accessPage.text);
  const confirmRes = await agent.post('/admin/access', { _csrf: accessToken, password, returnTo: '/admin' });
  assert.equal(confirmRes.status, 302);
  assert.equal(confirmRes.headers.location, '/admin');

  // Now the panel should actually render.
  const adminPage = await agent.get('/admin');
  assert.equal(adminPage.status, 200);
  assert.match(adminPage.text, /Admin console/i);
});

test('an "admin" who enters the wrong panel password stays locked out', async () => {
  const email = `admin2.${Date.now()}@example.com`;
  const password = 'a-strong-password-123';
  await User.create({ name: 'Careless Admin', email, password: await bcrypt.hash(password, 12), isVerified: true, role: 'admin' });

  const agent = createAgent(app);
  await loginAs(agent, email, password);

  const accessPage = await agent.get('/admin/access');
  const accessToken = extractCsrfToken(accessPage.text);
  const confirmRes = await agent.post('/admin/access', { _csrf: accessToken, password: 'definitely-wrong', returnTo: '/admin' });
  assert.equal(confirmRes.status, 302);
  assert.equal(confirmRes.headers.location, '/admin/access');

  const adminRes = await agent.get('/admin');
  assert.equal(adminRes.status, 302);
  assert.equal(adminRes.headers.location, '/admin/access?returnTo=/admin');
});
