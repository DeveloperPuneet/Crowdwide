const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { startTestDatabase, stopTestDatabase, extractCsrfToken, createAgent } = require('./helpers');

let dbHandle;
let app;
let User;
let Post;

test.before(async () => {
  dbHandle = await startTestDatabase();
  const createApp = require('../../src/app');
  app = createApp({ port: 3000 });
  User = require('../../src/models/User');
  Post = require('../../src/models/Post');
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

test('moderators can confirm the moderator panel but cannot open or submit admin panel access', async () => {
  const email = `moderator-access.${Date.now()}@example.com`;
  const password = 'a-strong-password-123';
  await User.create({ name: 'Moderator Access', email, password: await bcrypt.hash(password, 12), isVerified: true, role: 'moderator' });

  const agent = createAgent(app);
  await loginAs(agent, email, password);

  const moderatorPanel = await agent.get('/moderator');
  assert.equal(moderatorPanel.status, 302);
  assert.equal(moderatorPanel.headers.location, '/moderator/access?returnTo=/moderator');
  const moderatorAccess = await agent.get('/moderator/access');
  assert.equal(moderatorAccess.status, 200);

  assert.equal((await agent.get('/admin/access')).status, 403);
  const adminAttempt = await agent.post('/admin/access', {
    _csrf: extractCsrfToken(moderatorAccess.text),
    password,
    returnTo: '/admin'
  });
  assert.equal(adminAttempt.status, 403);

  const confirmModerator = await agent.post('/moderator/access', {
    _csrf: extractCsrfToken(moderatorAccess.text),
    password,
    returnTo: '/moderator'
  });
  assert.equal(confirmModerator.status, 302);
  assert.equal(confirmModerator.headers.location, '/moderator');
  assert.equal((await agent.get('/moderator')).status, 200);
});

test('regular users cannot view or submit either panel password confirmation', async () => {
  const email = `regular-panel-access.${Date.now()}@example.com`;
  const password = 'a-strong-password-123';
  await User.create({ name: 'Regular Panel Access', email, password: await bcrypt.hash(password, 12), isVerified: true, role: 'user' });

  const agent = createAgent(app);
  await loginAs(agent, email, password);
  const dashboard = await agent.get('/dashboard');
  const token = extractCsrfToken(dashboard.text);

  for (const panel of ['admin', 'moderator']) {
    assert.equal((await agent.get(`/${panel}/access`)).status, 403);
    const attempt = await agent.post(`/${panel}/access`, { _csrf: token, password, returnTo: `/${panel}` });
    assert.equal(attempt.status, 403);
  }
});

test('post moderation options use the current role and are hidden from regular users', async () => {
  const password = 'a-strong-password-123';
  const staffEmail = `fresh-role.${Date.now()}@example.com`;
  const author = await User.create({
    name: 'Post Author',
    email: `post-author.${Date.now()}@example.com`,
    password: await bcrypt.hash(password, 12),
    isVerified: true,
    role: 'user'
  });
  const staff = await User.create({
    name: 'New Moderator',
    email: staffEmail,
    password: await bcrypt.hash(password, 12),
    isVerified: true,
    role: 'user'
  });
  const post = await Post.create({ author: author._id, body: 'Review this post', type: 'post', status: 'published' });

  const agent = createAgent(app);
  await loginAs(agent, staffEmail, password);
  const regularView = await agent.get(`/posts/${post._id}`);
  assert.equal(regularView.status, 200);
  assert.doesNotMatch(regularView.text, /Moderation options/);

  await User.updateOne({ _id: staff._id }, { role: 'moderator' });
  const promotedView = await agent.get(`/posts/${post._id}`);
  assert.match(promotedView.text, /Moderation options/);
  assert.match(promotedView.text, /Send for approval/);

  await User.updateOne({ _id: staff._id }, { role: 'user' });
  const demotedView = await agent.get(`/posts/${post._id}`);
  assert.doesNotMatch(demotedView.text, /Moderation options/);

  await User.updateOne({ _id: staff._id }, { role: 'admin' });
  const adminView = await agent.get(`/posts/${post._id}`);
  assert.match(adminView.text, /Moderation options/);
  assert.match(adminView.text, /Apply action/);
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

  const moderatorAccess = await agent.get('/moderator/access');
  assert.equal(moderatorAccess.status, 200);
  const moderatorConfirm = await agent.post('/moderator/access', {
    _csrf: extractCsrfToken(moderatorAccess.text),
    password,
    returnTo: '/moderator'
  });
  assert.equal(moderatorConfirm.status, 302);
  assert.equal(moderatorConfirm.headers.location, '/moderator');
  assert.equal((await agent.get('/moderator')).status, 200);
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
