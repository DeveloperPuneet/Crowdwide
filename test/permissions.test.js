const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../src/models/User');
const { requireAdmin, requireModerator, requirePanelPassword } = require('../src/middleware/roles');

function mockUserLookup(t, fakeUser) {
  // roles.js does User.findById(id).select(fields).lean() -- stub the chain
  // to resolve with a fixed fake user, without touching a real database.
  t.mock.method(User, 'findById', () => ({
    select: () => ({
      lean: () => Promise.resolve(fakeUser)
    })
  }));
}

function fakeReqRes(sessionUser = { id: 'u1' }) {
  const req = { session: { user: sessionUser } };
  const res = { status: (code) => ({ render: (view, locals) => { res.rendered = { code, view, locals }; } }) };
  return { req, res };
}

test('requireAdmin redirects to login when no session user is present', async (t) => {
  const { req, res } = fakeReqRes(null);
  req.session.user = null;
  let nextCalled = false;
  res.redirect = () => { throw new Error('should not redirect via res.redirect in this branch'); };
  // loadRoleUser itself redirects when there's no session user.
  req.redirected = null;
  res.redirect = (to) => { req.redirected = to; };
  requireAdmin(req, res, () => { nextCalled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nextCalled, false);
  assert.equal(req.redirected, '/auth/login');
});

test('requireAdmin blocks a plain "user" role with a 403', async (t) => {
  mockUserLookup(t, { role: 'user', name: 'Regular' });
  const { req, res } = fakeReqRes();
  let nextCalled = false;
  requireAdmin(req, res, () => { nextCalled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nextCalled, false);
  assert.equal(res.rendered.code, 403);
});

test('requireAdmin blocks a "moderator" role with a 403', async (t) => {
  mockUserLookup(t, { role: 'moderator', name: 'Mod' });
  const { req, res } = fakeReqRes();
  let nextCalled = false;
  requireAdmin(req, res, () => { nextCalled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nextCalled, false);
  assert.equal(res.rendered.code, 403);
});

test('requireAdmin allows an "admin" role through', async (t) => {
  mockUserLookup(t, { role: 'admin', name: 'Boss' });
  const { req, res } = fakeReqRes();
  let nextCalled = false;
  requireAdmin(req, res, () => { nextCalled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nextCalled, true);
  assert.equal(req.roleUser.role, 'admin');
});

test('requireModerator blocks a plain "user" role with a 403', async (t) => {
  mockUserLookup(t, { role: 'user', name: 'Regular' });
  const { req, res } = fakeReqRes();
  let nextCalled = false;
  requireModerator(req, res, () => { nextCalled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nextCalled, false);
  assert.equal(res.rendered.code, 403);
});

test('requireModerator allows both "moderator" and "admin" roles through', async (t) => {
  mockUserLookup(t, { role: 'moderator', name: 'Mod' });
  const { req, res } = fakeReqRes();
  let nextCalled = false;
  requireModerator(req, res, () => { nextCalled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nextCalled, true);

  t.mock.reset();
  mockUserLookup(t, { role: 'admin', name: 'Boss' });
  const second = fakeReqRes();
  let nextCalledAgain = false;
  requireModerator(second.req, second.res, () => { nextCalledAgain = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nextCalledAgain, true);
});

test('requirePanelPassword blocks access until the panel password has been confirmed', () => {
  const req = { session: {} };
  let redirectedTo = null;
  const res = { redirect: (to) => { redirectedTo = to; } };
  let nextCalled = false;
  requirePanelPassword('admin')(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(redirectedTo, '/admin/access?returnTo=/admin');
});

test('requirePanelPassword allows access once confirmed and not yet expired', () => {
  const req = { session: { panelAccess: { admin: Date.now() + 60000 } } };
  const res = { redirect: () => { throw new Error('should not redirect'); } };
  let nextCalled = false;
  requirePanelPassword('admin')(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('requirePanelPassword re-blocks access once the confirmation has expired', () => {
  const req = { session: { panelAccess: { admin: Date.now() - 1000 } } };
  let redirectedTo = null;
  const res = { redirect: (to) => { redirectedTo = to; } };
  let nextCalled = false;
  requirePanelPassword('admin')(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(redirectedTo, '/admin/access?returnTo=/admin');
});

test('requirePanelPassword tracks each panel independently (moderator confirmation does not grant admin)', () => {
  const req = { session: { panelAccess: { moderator: Date.now() + 60000 } } };
  let redirectedTo = null;
  const res = { redirect: (to) => { redirectedTo = to; } };
  let nextCalled = false;
  requirePanelPassword('admin')(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(redirectedTo, '/admin/access?returnTo=/admin');
});
