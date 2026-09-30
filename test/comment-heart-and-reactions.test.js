const test = require('node:test');
const assert = require('node:assert/strict');
const Comment = require('../src/models/Comment');
const User = require('../src/models/User');
const Notification = require('../src/models/Notification');
const interactionController = require('../src/controllers/interactionController');

// toggleAuthorHeart/toggleCommentReaction call the shared notify() helper,
// which looks up the recipient's notification preferences and writes a
// Notification - stub both so these stay unit tests, not integration tests.
function mockNotifyDependencies(t) {
  t.mock.method(User, 'findById', () => ({ select: () => ({ lean: () => Promise.resolve({ notificationPreferences: {} }) }) }));
  t.mock.method(Notification, 'create', () => Promise.resolve({}));
}

function fakeReactionEntry(emoji, users) {
  return { emoji, users, toObject() { return { emoji, users }; } };
}

function fakeComment({ author = 'commenter-1', postAuthor = 'owner-1', heartedByAuthor = false, reactions = [], community = null } = {}) {
  const doc = {
    _id: 'comment-1',
    author,
    heartedByAuthor,
    reactions,
    post: { _id: 'post-1', author: postAuthor, status: 'published', community },
    saved: null,
    save() { this.saved = { heartedByAuthor: this.heartedByAuthor, reactions: this.reactions }; return Promise.resolve(this); },
    set(field, value) { this[field] = value; }
  };
  return { populate: () => Promise.resolve(doc), doc };
}

function mockReq(userId, body = {}) {
  return { params: { id: 'comment-1' }, session: { user: { id: userId, name: 'Tester' } }, body, get: () => null };
}

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.redirect = () => res;
  return res;
}

test('only the post author can heart a comment', async (t) => {
  const { populate, doc } = fakeComment({ postAuthor: 'owner-1' });
  t.mock.method(Comment, 'findById', () => ({ populate }));
  const req = mockReq('someone-else');
  req.get = () => 'XMLHttpRequest';
  const res = mockRes();
  await interactionController.toggleAuthorHeart(req, res);
  assert.equal(res.body.ok, false);
  assert.equal(doc.saved, null, 'must not save when the requester is not the post author');
});

test('the post author can toggle the heart on and back off', async (t) => {
  mockNotifyDependencies(t);
  const { populate, doc } = fakeComment({ postAuthor: 'owner-1', heartedByAuthor: false });
  t.mock.method(Comment, 'findById', () => ({ populate }));
  const req = mockReq('owner-1');
  req.get = () => 'XMLHttpRequest';
  const res1 = mockRes();
  await interactionController.toggleAuthorHeart(req, res1);
  assert.equal(res1.body.hearted, true);
  assert.equal(doc.heartedByAuthor, true);

  const res2 = mockRes();
  await interactionController.toggleAuthorHeart(req, res2);
  assert.equal(res2.body.hearted, false);
  assert.equal(doc.heartedByAuthor, false);
});

test('an unsupported emoji on a comment is rejected without saving', async (t) => {
  const { populate, doc } = fakeComment();
  t.mock.method(Comment, 'findById', () => ({ populate }));
  const req = mockReq('viewer-1', { emoji: '🍕' });
  req.get = () => 'XMLHttpRequest';
  const res = mockRes();
  await interactionController.toggleCommentReaction(req, res);
  assert.equal(res.body.ok, false);
  assert.equal(doc.saved, null);
});

test('reacting to a comment saves the reaction and returns a summary', async (t) => {
  mockNotifyDependencies(t);
  const { populate, doc } = fakeComment({ reactions: [fakeReactionEntry('👍', ['other-user'])] });
  t.mock.method(Comment, 'findById', () => ({ populate }));
  const req = mockReq('viewer-1', { emoji: '👍' });
  req.get = () => 'XMLHttpRequest';
  const res = mockRes();
  await interactionController.toggleCommentReaction(req, res);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.reactions, [{ emoji: '👍', count: 2, reacted: true }]);
  assert.deepEqual(doc.saved.reactions, [{ emoji: '👍', users: ['other-user', 'viewer-1'] }]);
});

test('a comment on a private community post the viewer cannot access is not hearted or reacted to', async (t) => {
  const Community = require('../src/models/Community');
  t.mock.method(Community, 'exists', () => Promise.resolve(true));
  const { populate, doc } = fakeComment({ postAuthor: 'owner-1', community: 'private-community' });
  t.mock.method(Comment, 'findById', () => ({ populate }));
  const req = mockReq('owner-1', { emoji: '👍' });
  req.get = () => 'XMLHttpRequest';
  const res = mockRes();
  await interactionController.toggleCommentReaction(req, res);
  assert.equal(res.body.ok, false);
  assert.equal(doc.saved, null);
});
