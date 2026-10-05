const test = require('node:test');
const assert = require('node:assert/strict');
const Message = require('../src/models/Message');
const User = require('../src/models/User');
const chatController = require('../src/controllers/chatController');
const interactionController = require('../src/controllers/interactionController');

function mockRes() {
  const res = { rendered: null, redirectedTo: null };
  res.render = (view, data) => { res.rendered = { view, data }; return res; };
  res.redirect = (to) => { res.redirectedTo = to; return res; };
  res.status = () => res;
  return res;
}

function message({ sender, recipient, id, readAt = null }) {
  return { _id: id, sender: { _id: sender, name: sender }, recipient: { _id: recipient, name: recipient }, body: 'hi', createdAt: new Date(), readAt };
}

test('messages inbox: a thread the other person started, unreplied and undecided, is excluded from the inbox and counted as a request', async (t) => {
  t.mock.method(Message, 'find', () => ({
    sort: () => ({ limit: () => ({ populate: () => ({ populate: () => ({ lean: () => Promise.resolve([
      message({ sender: 'stranger-1', recipient: 'viewer-1', id: 'm1' }) // stranger messaged viewer; viewer never replied
    ]) }) }) }) })
  }));
  t.mock.method(User, 'findById', () => ({ select: () => ({ lean: () => Promise.resolve({ acceptedDmFrom: [], declinedDmFrom: [] }) }) }));
  const req = { session: { user: { id: 'viewer-1' } } };
  const res = mockRes();
  await interactionController.messages(req, res);
  assert.equal(res.rendered.data.conversations.length, 0, 'the pending thread should not appear in the ordinary inbox');
  assert.equal(res.rendered.data.requestCount, 1);
});

test('messages inbox: a thread the viewer has replied to appears normally, never as a request', async (t) => {
  t.mock.method(Message, 'find', () => ({
    sort: () => ({ limit: () => ({ populate: () => ({ populate: () => ({ lean: () => Promise.resolve([
      message({ sender: 'stranger-1', recipient: 'viewer-1', id: 'm1' }),
      message({ sender: 'viewer-1', recipient: 'stranger-1', id: 'm2' })
    ]) }) }) }) })
  }));
  t.mock.method(User, 'findById', () => ({ select: () => ({ lean: () => Promise.resolve({ acceptedDmFrom: [], declinedDmFrom: [] }) }) }));
  const req = { session: { user: { id: 'viewer-1' } } };
  const res = mockRes();
  await interactionController.messages(req, res);
  assert.equal(res.rendered.data.conversations.length, 1);
  assert.equal(res.rendered.data.requestCount, 0);
});

test('messages inbox: a declined thread is hidden from both the inbox and the request count', async (t) => {
  t.mock.method(Message, 'find', () => ({
    sort: () => ({ limit: () => ({ populate: () => ({ populate: () => ({ lean: () => Promise.resolve([
      message({ sender: 'stranger-1', recipient: 'viewer-1', id: 'm1' })
    ]) }) }) }) })
  }));
  t.mock.method(User, 'findById', () => ({ select: () => ({ lean: () => Promise.resolve({ acceptedDmFrom: [], declinedDmFrom: ['stranger-1'] }) }) }));
  const req = { session: { user: { id: 'viewer-1' } } };
  const res = mockRes();
  await interactionController.messages(req, res);
  assert.equal(res.rendered.data.conversations.length, 0);
  assert.equal(res.rendered.data.requestCount, 0);
});

test('messageRequests: lists pending requests but excludes blocked senders', async (t) => {
  t.mock.method(Message, 'find', () => ({
    sort: () => ({ limit: () => ({ populate: () => ({ populate: () => ({ lean: () => Promise.resolve([
      message({ sender: 'stranger-1', recipient: 'viewer-1', id: 'm1' }),
      message({ sender: 'blocked-1', recipient: 'viewer-1', id: 'm2' })
    ]) }) }) }) })
  }));
  t.mock.method(User, 'findById', () => ({ select: () => ({ lean: () => Promise.resolve({ acceptedDmFrom: [], declinedDmFrom: [], blockedUsers: ['blocked-1'] }) }) }));
  const req = { session: { user: { id: 'viewer-1' } } };
  const res = mockRes();
  await interactionController.messageRequests(req, res);
  assert.equal(res.rendered.data.requests.length, 1);
  assert.equal(res.rendered.data.requests[0].person._id, 'stranger-1');
});

test('dmThread: pending is true when the other person started the thread and the viewer has not decided', async (t) => {
  t.mock.method(User, 'findById', (id) => ({ select: () => ({ lean: () => Promise.resolve(
    id === 'other-1' ? { _id: 'other-1', name: 'Stranger', blockedUsers: [] } : { blockedUsers: [], acceptedDmFrom: [], declinedDmFrom: [] }
  ) }) }));
  t.mock.method(Message, 'exists', (filter) => Promise.resolve(filter.sender === 'other-1'));
  t.mock.method(Message, 'updateMany', () => Promise.resolve());
  t.mock.method(Message, 'find', () => ({
    sort: () => ({
      limit: () => ({
        select: () => ({
          populate: () => ({
            populate: () => ({
              lean: () => Promise.resolve([])
            })
          })
        })
      })
    })
  }));
  const req = { params: { id: 'other-1' }, session: { user: { id: 'viewer-1' } }, query: {} };
  const res = mockRes();
  await chatController.dmThread(req, res);
  assert.equal(res.rendered.data.pending, true);
});

test('dmThread: pending is false once the viewer has already sent a reply', async (t) => {
  t.mock.method(User, 'findById', (id) => ({ select: () => ({ lean: () => Promise.resolve(
    id === 'other-1' ? { _id: 'other-1', name: 'Stranger', blockedUsers: [] } : { blockedUsers: [], acceptedDmFrom: [], declinedDmFrom: [] }
  ) }) }));
  t.mock.method(Message, 'exists', () => Promise.resolve(true));
  t.mock.method(Message, 'updateMany', () => Promise.resolve());
  t.mock.method(Message, 'find', () => ({
    sort: () => ({
      limit: () => ({
        select: () => ({
          populate: () => ({
            populate: () => ({
              lean: () => Promise.resolve([])
            })
          })
        })
      })
    })
  }));
  const req = { params: { id: 'other-1' }, session: { user: { id: 'viewer-1' } }, query: {} };
  const res = mockRes();
  await chatController.dmThread(req, res);
  assert.equal(res.rendered.data.pending, false);
});
