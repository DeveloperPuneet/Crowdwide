const test = require('node:test');
const assert = require('node:assert/strict');
const Message = require('../src/models/Message');
const GroupMessage = require('../src/models/GroupMessage');
const GroupConversation = require('../src/models/GroupConversation');
const chatController = require('../src/controllers/chatController');

function fakeReactionEntry(emoji, users) {
  return { emoji, users, toObject() { return { emoji, users }; } };
}

function fakeDoc(fields) {
  return {
    ...fields,
    saved: null,
    save() { this.saved = { reactions: this.reactions }; return Promise.resolve(this); },
    set(field, value) { this[field] = value; }
  };
}

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

test('dmReact: a non-participant cannot react to a direct message', async (t) => {
  const doc = fakeDoc({ _id: 'm1', sender: 'a', recipient: 'b', reactions: [] });
  t.mock.method(Message, 'findById', () => Promise.resolve(doc));
  const req = { params: { id: 'm1' }, session: { user: { id: 'stranger' } }, body: { emoji: '👍' } };
  const res = mockRes();
  await chatController.dmReact(req, res);
  assert.equal(res.statusCode, 404);
  assert.equal(doc.saved, null);
});

test('dmReact: the sender or recipient can toggle a reaction', async (t) => {
  const doc = fakeDoc({ _id: 'm1', sender: 'a', recipient: 'b', reactions: [] });
  t.mock.method(Message, 'findById', () => Promise.resolve(doc));
  const req = { params: { id: 'm1' }, session: { user: { id: 'b' } }, body: { emoji: '❤️' } };
  const res = mockRes();
  await chatController.dmReact(req, res);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.reactions, [{ emoji: '❤️', count: 1, reacted: true }]);
  assert.deepEqual(doc.saved.reactions, [{ emoji: '❤️', users: ['b'] }]);
});

test('dmReact: an unsupported emoji is rejected', async (t) => {
  const doc = fakeDoc({ _id: 'm1', sender: 'a', recipient: 'b', reactions: [] });
  t.mock.method(Message, 'findById', () => Promise.resolve(doc));
  const req = { params: { id: 'm1' }, session: { user: { id: 'a' } }, body: { emoji: 'nope' } };
  const res = mockRes();
  await chatController.dmReact(req, res);
  assert.equal(res.statusCode, 400);
});

test('groupReact: a non-member cannot react', async (t) => {
  t.mock.method(GroupConversation, 'findById', () => ({ select: () => ({ lean: () => Promise.resolve({ members: ['a', 'b'] }) }) }));
  const req = { params: { id: 'g1', messageId: 'gm1' }, session: { user: { id: 'stranger' } }, body: { emoji: '👍' } };
  const res = mockRes();
  await chatController.groupReact(req, res);
  assert.equal(res.statusCode, 404);
});

test('groupReact: a member can react to a message in their group', async (t) => {
  t.mock.method(GroupConversation, 'findById', () => ({ select: () => ({ lean: () => Promise.resolve({ members: ['a', 'b'] }) }) }));
  const doc = fakeDoc({ _id: 'gm1', group: 'g1', reactions: [fakeReactionEntry('🎉', ['a'])] });
  t.mock.method(GroupMessage, 'findOne', () => Promise.resolve(doc));
  const req = { params: { id: 'g1', messageId: 'gm1' }, session: { user: { id: 'b' } }, body: { emoji: '🎉' } };
  const res = mockRes();
  await chatController.groupReact(req, res);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.reactions, [{ emoji: '🎉', count: 2, reacted: true }]);
});

test('groupReact: a message not found in that group returns 404', async (t) => {
  t.mock.method(GroupConversation, 'findById', () => ({ select: () => ({ lean: () => Promise.resolve({ members: ['a', 'b'] }) }) }));
  t.mock.method(GroupMessage, 'findOne', () => Promise.resolve(null));
  const req = { params: { id: 'g1', messageId: 'missing' }, session: { user: { id: 'a' } }, body: { emoji: '👍' } };
  const res = mockRes();
  await chatController.groupReact(req, res);
  assert.equal(res.statusCode, 404);
});
