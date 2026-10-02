const test = require('node:test');
const assert = require('node:assert/strict');
const Message = require('../src/models/Message');
const GroupMessage = require('../src/models/GroupMessage');
const GroupConversation = require('../src/models/GroupConversation');
const User = require('../src/models/User');
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

function queryRows(rows) {
  const query = {
    sort() { return this; },
    limit() { return this; },
    select() { return this; },
    populate() { return this; },
    lean() { return Promise.resolve(rows); }
  };
  return query;
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

test('dmSearch only searches the two participants and treats query syntax literally', async (t) => {
  const selfId = 'a'.repeat(24);
  const otherId = 'b'.repeat(24);
  const messageId = 'd'.repeat(24);
  const person = { _id: otherId, blockedUsers: [] };
  const viewer = { blockedUsers: [] };
  t.mock.method(User, 'findById', (id) => ({ select: () => ({ lean: () => Promise.resolve(String(id) === otherId ? person : viewer) }) }));
  let capturedFilter;
  t.mock.method(Message, 'find', (filter) => { capturedFilter = filter; return queryRows([{ _id: messageId, body: 'Literal a.* match', sender: { name: 'Asha' }, createdAt: new Date('2026-01-01') }]); });
  const req = { params: { id: otherId }, query: { q: 'a.*' }, session: { user: { id: selfId } } };
  const res = mockRes();
  await chatController.dmSearch(req, res);
  assert.deepEqual(capturedFilter.$or, [{ sender: selfId, recipient: otherId }, { sender: otherId, recipient: selfId }]);
  assert.equal(capturedFilter.body.source, 'a\\.\\*');
  assert.deepEqual(res.body.results[0], {
    id: messageId,
    sender: 'Asha',
    excerpt: 'Literal a.* match',
    createdAt: new Date('2026-01-01'),
    href: `/messages/${otherId}?focus=${messageId}`
  });
});

test('groupSearch hides results from users who are not current members', async (t) => {
  const groupId = 'e'.repeat(24);
  t.mock.method(GroupConversation, 'findById', () => ({ populate: () => ({ lean: () => Promise.resolve({ _id: groupId, members: ['f'.repeat(24)] }) }) }));
  const search = t.mock.method(GroupMessage, 'find', () => queryRows([]));
  const req = { params: { id: groupId }, query: { q: 'secret' }, session: { user: { id: '0'.repeat(24) } } };
  const res = mockRes();
  await chatController.groupSearch(req, res);
  assert.equal(res.statusCode, 404);
  assert.equal(search.mock.callCount(), 0);
});

test('groupSearch returns results only for the authorized group', async (t) => {
  const groupId = '1'.repeat(24);
  const messageId = '2'.repeat(24);
  t.mock.method(GroupConversation, 'findById', () => ({ populate: () => ({ lean: () => Promise.resolve({ _id: groupId, members: ['3'.repeat(24)] }) }) }));
  let capturedFilter;
  t.mock.method(GroupMessage, 'find', (filter) => { capturedFilter = filter; return queryRows([{ _id: messageId, body: 'Planning notes', sender: { name: 'Meera' }, createdAt: new Date('2026-02-01') }]); });
  const req = { params: { id: groupId }, query: { q: 'planning' }, session: { user: { id: '3'.repeat(24) } } };
  const res = mockRes();
  await chatController.groupSearch(req, res);
  assert.equal(String(capturedFilter.group), groupId);
  assert.deepEqual(capturedFilter.kind, { $ne: 'system' });
  assert.equal(res.body.results[0].href, `/groups/${groupId}?focus=${messageId}`);
});
