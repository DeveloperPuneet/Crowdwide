const test = require('node:test');
const assert = require('node:assert/strict');
const Comment = require('../src/models/Comment');
const Report = require('../src/models/Report');
const { reportComment } = require('../src/controllers/interactionController');

function fakeReqRes(comment, userId, reason = 'Spam or scam') {
  const req = { params: { id: 'c1' }, session: { user: { id: userId } }, body: { reason } };
  const res = { redirected: null, redirect(to) { this.redirected = to; return this; } };
  return { req, res, comment };
}

function mockCommentLookup(t, comment) {
  t.mock.method(Comment, 'findById', () => ({
    populate: () => ({ lean: () => Promise.resolve(comment) })
  }));
}

test('reportComment saves the reason and comment context for an accessible comment', async (t) => {
  const comment = {
    _id: 'c1', author: 'u2', body: 'Please review this comment.',
    post: { _id: 'p1', author: 'u3', status: 'published', community: null }
  };
  mockCommentLookup(t, comment);
  const update = t.mock.method(Report, 'updateOne', () => Promise.resolve());
  const { req, res } = fakeReqRes(comment, 'u1');

  await reportComment(req, res);

  assert.equal(update.mock.callCount(), 1);
  assert.deepEqual(update.mock.calls[0].arguments[0], { reporter: 'u1', targetType: 'comment', target: 'c1' });
  assert.equal(update.mock.calls[0].arguments[1].$setOnInsert.reason, 'Spam or scam');
  assert.equal(update.mock.calls[0].arguments[1].$setOnInsert.contextText, 'Comment: Please review this comment.');
  assert.equal(res.redirected, '/posts/p1#comment-c1');
  assert.equal(req.session.flash.type, 'success');
});

test('reportComment prevents reporting your own comment', async (t) => {
  const comment = {
    _id: 'c1', author: 'u1', body: 'My comment.',
    post: { _id: 'p1', author: 'u2', status: 'published', community: null }
  };
  mockCommentLookup(t, comment);
  const update = t.mock.method(Report, 'updateOne', () => Promise.resolve());
  const { req, res } = fakeReqRes(comment, 'u1');

  await reportComment(req, res);

  assert.equal(update.mock.callCount(), 0);
  assert.equal(res.redirected, '/posts/p1#comment-c1');
  assert.equal(req.session.flash.type, 'error');
});
