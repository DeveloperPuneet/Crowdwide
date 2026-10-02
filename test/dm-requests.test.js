const test = require('node:test');
const assert = require('node:assert/strict');
const { isPendingRequest, tooManyNewDmRequests, MAX_NEW_DM_REQUESTS_PER_WINDOW } = require('../src/services/chat');
const Message = require('../src/models/Message');
const User = require('../src/models/User');
const chatController = require('../src/controllers/chatController');

test('isPendingRequest: pending only when the viewer has never replied and has not decided', () => {
  assert.equal(isPendingRequest({ viewerHasSent: false, accepted: false, declined: false }), true);
  assert.equal(isPendingRequest({ viewerHasSent: true, accepted: false, declined: false }), false, 'replying counts as deciding');
  assert.equal(isPendingRequest({ viewerHasSent: false, accepted: true, declined: false }), false);
  assert.equal(isPendingRequest({ viewerHasSent: false, accepted: false, declined: true }), false);
});

test('tooManyNewDmRequests: false when under the limit, true at/above it, replies to existing contacts never count', async (t) => {
  const priorContacts = ['old-1', 'old-2'];
  t.mock.method(Message, 'distinct', (field, filter) => {
    if (filter.createdAt.$lt) return Promise.resolve(priorContacts);
    // "recent" recipients: a mix of brand-new people and someone already contacted before
    return Promise.resolve(['old-1', ...Array.from({ length: MAX_NEW_DM_REQUESTS_PER_WINDOW - 1 }, (_, i) => `new-${i}`)]);
  });
  const underLimit = await tooManyNewDmRequests(Message, 'sender-1');
  assert.equal(underLimit, false, `${MAX_NEW_DM_REQUESTS_PER_WINDOW - 1} new contacts is still under the cap`);
});

test('tooManyNewDmRequests: true once new contacts in the window reach the cap', async (t) => {
  t.mock.method(Message, 'distinct', (field, filter) => {
    if (filter.createdAt.$lt) return Promise.resolve([]);
    return Promise.resolve(Array.from({ length: MAX_NEW_DM_REQUESTS_PER_WINDOW }, (_, i) => `new-${i}`));
  });
  assert.equal(await tooManyNewDmRequests(Message, 'sender-1'), true);
});

function mockRes() {
  const res = { statusCode: 200, body: null, redirectedTo: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.redirect = (to) => { res.redirectedTo = to; return res; };
  return res;
}

test('dmSend: a brand-new conversation is rejected once the new-request rate limit is hit', async (t) => {
  t.mock.method(User, 'findById', (id) => ({
    select: () => ({ lean: () => Promise.resolve(id === 'recipient-1' ? { _id: 'recipient-1', isVerified: true, blockedUsers: [] } : { blockedUsers: [], acceptedDmFrom: [] }) })
  }));
  t.mock.method(Message, 'exists', () => Promise.resolve(false));
  t.mock.method(Message, 'distinct', (field, filter) => Promise.resolve(filter.createdAt.$lt ? [] : Array.from({ length: MAX_NEW_DM_REQUESTS_PER_WINDOW }, (_, i) => `x${i}`)));
  const req = { params: { id: 'recipient-1' }, session: { user: { id: 'sender-1', name: 'Sender' } }, body: { body: 'hi there' }, get: () => null };
  const res = mockRes();
  await chatController.dmSend(req, res);
  assert.equal(res.redirectedTo, '/messages/recipient-1');
  assert.equal(req.session.flash.type, 'error');
  assert.match(req.session.flash.message, /started a lot of new conversations/);
});

test('dmSend: replying to an existing thread is never rate-limited even if the sender is "over" the new-contact cap', async (t) => {
  t.mock.method(User, 'findById', (id) => ({
    select: () => ({ lean: () => Promise.resolve(id === 'recipient-1' ? { _id: 'recipient-1', isVerified: true, blockedUsers: [] } : { blockedUsers: [], acceptedDmFrom: [] }) })
  }));
  t.mock.method(Message, 'exists', () => Promise.resolve(true));
  let distinctCalled = false;
  t.mock.method(Message, 'distinct', () => { distinctCalled = true; return Promise.resolve([]); });
  t.mock.method(User, 'updateOne', () => Promise.resolve());
  t.mock.method(Message, 'create', () => Promise.resolve({ toObject: () => ({ _id: 'm1', sender: 'sender-1', recipient: 'recipient-1', body: 'hi', reactions: [] }) }));
  const req = { params: { id: 'recipient-1' }, session: { user: { id: 'sender-1', name: 'Sender' } }, body: { body: 'hi again' }, get: () => null };
  const res = mockRes();
  await chatController.dmSend(req, res);
  assert.equal(distinctCalled, false, 'the rate-limit check should be skipped entirely for an existing thread');
  assert.equal(res.redirectedTo, '/messages/recipient-1');
});

test('dmSend: sending auto-accepts the recipient (replying is an explicit signal of acceptance)', async (t) => {
  t.mock.method(User, 'findById', (id) => ({
    select: () => ({ lean: () => Promise.resolve(id === 'recipient-1' ? { _id: 'recipient-1', isVerified: true, blockedUsers: [] } : { blockedUsers: [], acceptedDmFrom: [] }) })
  }));
  t.mock.method(Message, 'exists', () => Promise.resolve(false));
  t.mock.method(Message, 'distinct', () => Promise.resolve([]));
  const updateCalls = t.mock.method(User, 'updateOne', () => Promise.resolve());
  t.mock.method(Message, 'create', () => Promise.resolve({ toObject: () => ({ _id: 'm1', sender: 'sender-1', recipient: 'recipient-1', body: 'hi', reactions: [] }) }));
  const req = { params: { id: 'recipient-1' }, session: { user: { id: 'sender-1', name: 'Sender' } }, body: { body: 'accepting you implicitly' }, get: () => null };
  const res = mockRes();
  await chatController.dmSend(req, res);
  assert.equal(updateCalls.mock.callCount(), 1);
  assert.equal(updateCalls.mock.calls[0].arguments[0]._id, 'sender-1');
  assert.deepEqual(updateCalls.mock.calls[0].arguments[1].$addToSet, { acceptedDmFrom: 'recipient-1' });
});

test('dmRequestRespond: accepting adds to acceptedDmFrom and redirects into the thread', async (t) => {
  const otherId = '507f1f77bcf86cd799439011';
  const updateCalls = t.mock.method(User, 'updateOne', () => Promise.resolve());
  const req = { params: { id: otherId }, session: { user: { id: 'viewer-1' } }, body: { decision: 'accept' } };
  const res = mockRes();
  await chatController.dmRequestRespond(req, res);
  assert.equal(res.redirectedTo, `/messages/${otherId}`);
  assert.deepEqual(updateCalls.mock.calls[0].arguments[1].$addToSet, { acceptedDmFrom: otherId });
});

test('dmRequestRespond: declining adds to declinedDmFrom and redirects to the requests list', async (t) => {
  const otherId = '507f1f77bcf86cd799439011';
  const updateCalls = t.mock.method(User, 'updateOne', () => Promise.resolve());
  const req = { params: { id: otherId }, session: { user: { id: 'viewer-1' } }, body: { decision: 'decline' } };
  const res = mockRes();
  await chatController.dmRequestRespond(req, res);
  assert.equal(res.redirectedTo, '/messages/requests');
  assert.deepEqual(updateCalls.mock.calls[0].arguments[1].$addToSet, { declinedDmFrom: otherId });
});

test('dmRequestRespond: an invalid id just bounces back to the requests list', async (t) => {
  const req = { params: { id: 'not-an-id' }, session: { user: { id: 'viewer-1' } }, body: { decision: 'accept' } };
  const res = mockRes();
  await chatController.dmRequestRespond(req, res);
  assert.equal(res.redirectedTo, '/messages/requests');
});
