const test = require('node:test');
const assert = require('node:assert/strict');
const Appeal = require('../src/models/Appeal');
const User = require('../src/models/User');
const AuditLog = require('../src/models/AuditLog');
const { logEvent } = require('../src/services/accountHistory');
const adminController = require('../src/controllers/adminController');

function fakeAppeal(fields) {
  const doc = { status: 'pending', actionType: 'suspension', user: 'target-user', ...fields, saved: null };
  doc.save = function () { this.saved = { status: this.status, reviewedBy: this.reviewedBy, reviewNote: this.reviewNote }; return Promise.resolve(this); };
  return doc;
}

function fakeReqRes(roleUser, body = {}) {
  const req = { params: { id: 'appeal-1' }, session: {}, body, roleUser, ip: '1.1.1.1', get: () => 'test-agent' };
  const res = { redirected: null, redirect: (to) => { res.redirected = to; } };
  return { req, res };
}

test('a moderator (not just an admin) can resolve an appeal, and is sent back to the moderator console', async (t) => {
  const appeal = fakeAppeal({});
  t.mock.method(Appeal, 'findById', () => Promise.resolve(appeal));
  t.mock.method(User, 'findByIdAndUpdate', () => Promise.resolve());
  t.mock.method(AuditLog, 'create', () => Promise.resolve());
  const { req, res } = fakeReqRes({ _id: 'mod-1', role: 'moderator' }, { decision: 'approve' });
  await adminController.resolveAppeal(req, res);
  assert.equal(res.redirected, '/moderator#appeals');
  assert.equal(appeal.saved.status, 'approved');
  assert.equal(String(appeal.saved.reviewedBy), 'mod-1');
});

test('an admin resolving an appeal is sent back to the admin console', async (t) => {
  const appeal = fakeAppeal({});
  t.mock.method(Appeal, 'findById', () => Promise.resolve(appeal));
  t.mock.method(User, 'findByIdAndUpdate', () => Promise.resolve());
  t.mock.method(AuditLog, 'create', () => Promise.resolve());
  const { req, res } = fakeReqRes({ _id: 'admin-1', role: 'admin' }, { decision: 'deny' });
  await adminController.resolveAppeal(req, res);
  assert.equal(res.redirected, '/admin#appeals');
  assert.equal(appeal.saved.status, 'denied');
});

test('approving a suspension appeal lifts the suspension', async (t) => {
  const appeal = fakeAppeal({ actionType: 'suspension', user: 'target-user' });
  t.mock.method(Appeal, 'findById', () => Promise.resolve(appeal));
  const updateCalls = t.mock.method(User, 'findByIdAndUpdate', () => Promise.resolve());
  t.mock.method(AuditLog, 'create', () => Promise.resolve());
  const { req, res } = fakeReqRes({ _id: 'mod-1', role: 'moderator' }, { decision: 'approve' });
  await adminController.resolveAppeal(req, res);
  assert.equal(updateCalls.mock.callCount(), 1);
  assert.equal(updateCalls.mock.calls[0].arguments[0], 'target-user');
  assert.deepEqual(updateCalls.mock.calls[0].arguments[1], { suspendedUntil: null, suspensionReason: '' });
});

test('denying an appeal does not touch the user record', async (t) => {
  const appeal = fakeAppeal({ actionType: 'suspension' });
  t.mock.method(Appeal, 'findById', () => Promise.resolve(appeal));
  const updateCalls = t.mock.method(User, 'findByIdAndUpdate', () => Promise.resolve());
  t.mock.method(AuditLog, 'create', () => Promise.resolve());
  const { req, res } = fakeReqRes({ _id: 'mod-1', role: 'moderator' }, { decision: 'deny' });
  await adminController.resolveAppeal(req, res);
  assert.equal(updateCalls.mock.callCount(), 0);
  assert.equal(appeal.saved.status, 'denied');
});

test('a non-pending appeal is rejected without being modified', async (t) => {
  const appeal = fakeAppeal({ status: 'approved' });
  t.mock.method(Appeal, 'findById', () => Promise.resolve(appeal));
  const updateCalls = t.mock.method(User, 'findByIdAndUpdate', () => Promise.resolve());
  const { req, res } = fakeReqRes({ _id: 'mod-1', role: 'moderator' }, { decision: 'approve' });
  await adminController.resolveAppeal(req, res);
  assert.equal(res.redirected, '/moderator#appeals');
  assert.equal(appeal.saved, null);
  assert.equal(updateCalls.mock.callCount(), 0);
  assert.equal(req.session.flash.type, 'error');
});
