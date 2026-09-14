const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../src/models/User');
const Appeal = require('../src/models/Appeal');
const { submitAppeal, submitPublicAppeal } = require('../src/controllers/appealController');

function fakeReqRes(overrides = {}) {
  const req = { session: { user: { id: 'u1' } }, body: {}, ...overrides };
  const res = { redirected: null, redirect: (to) => { res.redirected = to; } };
  return { req, res };
}

// --- submitAppeal (authenticated: posting-restriction / warning) --------

test('submitAppeal rejects an unknown actionType without touching the database', async (t) => {
  const findByIdCalls = t.mock.method(User, 'findById');
  const { req, res } = fakeReqRes({ body: { actionType: 'suspension', message: 'please' } });
  await submitAppeal(req, res);
  assert.equal(res.redirected, '/settings/moderation');
  assert.equal(req.session.flash.type, 'error');
  assert.equal(findByIdCalls.mock.callCount(), 0);
});

test('submitAppeal rejects a missing message', async (t) => {
  const { req, res } = fakeReqRes({ body: { actionType: 'posting-restriction' } });
  await submitAppeal(req, res);
  assert.equal(req.session.flash.type, 'error');
});

test('submitAppeal rejects a posting-restriction appeal when there is no active restriction', async (t) => {
  t.mock.method(User, 'findById', () => ({
    select: () => Promise.resolve({ postingRestrictedUntil: null })
  }));
  const { req, res } = fakeReqRes({ body: { actionType: 'posting-restriction', message: 'Let me post again' } });
  await submitAppeal(req, res);
  assert.match(req.session.flash.message, /don't currently have an active posting restriction/);
});

test('submitAppeal rejects a second pending appeal for the same restriction', async (t) => {
  t.mock.method(User, 'findById', () => ({
    select: () => Promise.resolve({ _id: 'u1', postingRestrictedUntil: Date.now() + 60000, postingRestrictionReason: 'spam' })
  }));
  t.mock.method(Appeal, 'exists', () => Promise.resolve(true));
  const createCalls = t.mock.method(Appeal, 'create', () => Promise.resolve());
  const { req, res } = fakeReqRes({ body: { actionType: 'posting-restriction', message: 'Let me post again' } });
  await submitAppeal(req, res);
  assert.match(req.session.flash.message, /already have a pending appeal/);
  assert.equal(createCalls.mock.callCount(), 0);
});

test('submitAppeal creates a posting-restriction appeal when eligible', async (t) => {
  t.mock.method(User, 'findById', () => ({
    select: () => Promise.resolve({ _id: 'u1', postingRestrictedUntil: Date.now() + 60000, postingRestrictionReason: 'spam' })
  }));
  t.mock.method(Appeal, 'exists', () => Promise.resolve(false));
  const createCalls = t.mock.method(Appeal, 'create', () => Promise.resolve());
  const { req, res } = fakeReqRes({ body: { actionType: 'posting-restriction', message: 'Let me post again' } });
  await submitAppeal(req, res);
  assert.equal(createCalls.mock.callCount(), 1);
  assert.equal(createCalls.mock.calls[0].arguments[0].actionType, 'posting-restriction');
  assert.equal(req.session.flash.type, 'success');
});

test('submitAppeal rejects a warning appeal for a warning that does not exist', async (t) => {
  t.mock.method(User, 'findById', () => ({
    select: () => Promise.resolve({ _id: 'u1', warnings: { id: () => null } })
  }));
  const { req, res } = fakeReqRes({ body: { actionType: 'warning', warningId: 'w1', message: 'Not fair' } });
  await submitAppeal(req, res);
  assert.match(req.session.flash.message, /could not be found/);
});

test('submitAppeal creates a warning appeal for a warning that exists', async (t) => {
  const fakeWarning = { _id: 'w1', reason: 'Rude comment' };
  t.mock.method(User, 'findById', () => ({
    select: () => Promise.resolve({ _id: 'u1', warnings: { id: (id) => (id === 'w1' ? fakeWarning : null) } })
  }));
  t.mock.method(Appeal, 'exists', () => Promise.resolve(false));
  const createCalls = t.mock.method(Appeal, 'create', () => Promise.resolve());
  const { req, res } = fakeReqRes({ body: { actionType: 'warning', warningId: 'w1', message: 'Not fair' } });
  await submitAppeal(req, res);
  assert.equal(createCalls.mock.callCount(), 1);
  assert.equal(createCalls.mock.calls[0].arguments[0].warningId, 'w1');
});

// --- submitPublicAppeal (unauthenticated: suspension) --------------------

test('submitPublicAppeal creates a suspension appeal for a currently-suspended user', async (t) => {
  t.mock.method(User, 'findOne', () => ({
    select: () => Promise.resolve({ _id: 'u2', suspendedUntil: Date.now() + 60000, suspensionReason: 'harassment' })
  }));
  t.mock.method(Appeal, 'exists', () => Promise.resolve(false));
  const createCalls = t.mock.method(Appeal, 'create', () => Promise.resolve());
  const { req, res } = fakeReqRes({ session: {}, body: { email: 'suspended@example.com', message: 'It was a misunderstanding' } });
  await submitPublicAppeal(req, res);
  assert.equal(createCalls.mock.callCount(), 1);
  assert.equal(createCalls.mock.calls[0].arguments[0].actionType, 'suspension');
  assert.equal(res.redirected, '/auth/appeal');
});

test('submitPublicAppeal does not create an appeal for a user who is not suspended (but still shows the same generic message)', async (t) => {
  t.mock.method(User, 'findOne', () => ({
    select: () => Promise.resolve({ _id: 'u3', suspendedUntil: null })
  }));
  const createCalls = t.mock.method(Appeal, 'create', () => Promise.resolve());
  const { req, res } = fakeReqRes({ session: {}, body: { email: 'not-suspended@example.com', message: 'Please review' } });
  await submitPublicAppeal(req, res);
  assert.equal(createCalls.mock.callCount(), 0);
  assert.equal(req.session.flash.type, 'success');
  assert.equal(res.redirected, '/auth/appeal');
});

test('submitPublicAppeal does not create an appeal or throw for an email with no matching account', async (t) => {
  t.mock.method(User, 'findOne', () => ({ select: () => Promise.resolve(null) }));
  const createCalls = t.mock.method(Appeal, 'create', () => Promise.resolve());
  const { req, res } = fakeReqRes({ session: {}, body: { email: 'nobody@example.com', message: 'Please review' } });
  await submitPublicAppeal(req, res);
  assert.equal(createCalls.mock.callCount(), 0);
  assert.equal(req.session.flash.type, 'success');
});

test('submitPublicAppeal does not double-create when a suspension appeal is already pending', async (t) => {
  t.mock.method(User, 'findOne', () => ({
    select: () => Promise.resolve({ _id: 'u2', suspendedUntil: Date.now() + 60000, suspensionReason: 'harassment' })
  }));
  t.mock.method(Appeal, 'exists', () => Promise.resolve(true));
  const createCalls = t.mock.method(Appeal, 'create', () => Promise.resolve());
  const { req, res } = fakeReqRes({ session: {}, body: { email: 'suspended@example.com', message: 'Again' } });
  await submitPublicAppeal(req, res);
  assert.equal(createCalls.mock.callCount(), 0);
});
