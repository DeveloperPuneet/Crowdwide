const test = require('node:test');
const assert = require('node:assert/strict');
const Comment = require('../src/models/Comment');
const Post = require('../src/models/Post');
const interactionController = require('../src/controllers/interactionController');

function fakeComment({ author = 'owner-1', coAuthors = [], pinnedComment = null } = {}) {
  const post = {
    author,
    coAuthors,
    status: 'published',
    community: null,
    pinnedComment,
    save() { this.savedPinnedComment = this.pinnedComment; return Promise.resolve(this); }
  };
  const doc = { _id: 'comment-1', post };
  return {
    doc,
    populate: () => Promise.resolve(doc)
  };
}

function mockReq(userId) {
  return {
    params: { id: 'comment-1' },
    session: { user: { id: userId } },
    get: () => 'XMLHttpRequest'
  };
}

function mockRes() {
  return {
    body: null,
    json(body) { this.body = body; return this; },
    redirect() { return this; }
  };
}

test('only a post publisher can pin a comment', async (t) => {
  const lookup = fakeComment();
  t.mock.method(Comment, 'findById', () => ({ populate: lookup.populate }));
  const res = mockRes();

  await interactionController.togglePinnedComment(mockReq('someone-else'), res);

  assert.equal(res.body.ok, false);
  assert.equal(lookup.doc.post.savedPinnedComment, undefined);
});

test('a co-author can pin and unpin a comment', async (t) => {
  const lookup = fakeComment({ coAuthors: ['publisher-1'] });
  t.mock.method(Comment, 'findById', () => ({ populate: lookup.populate }));
  const req = mockReq('publisher-1');
  const res = mockRes();

  await interactionController.togglePinnedComment(req, res);
  assert.equal(res.body.pinned, true);
  assert.equal(res.body.pinnedComment, 'comment-1');
  assert.equal(lookup.doc.post.savedPinnedComment, 'comment-1');

  await interactionController.togglePinnedComment(req, res);
  assert.equal(res.body.pinned, false);
  assert.equal(res.body.pinnedComment, null);
  assert.equal(lookup.doc.post.savedPinnedComment, null);
});

test('post schema stores the single pinned comment reference', () => {
  assert.equal(Post.schema.path('pinnedComment').options.ref, 'Comment');
});

test('pinned replies are moved to the top without losing their own replies', () => {
  const pinnedReply = { _id: 'pinned', children: [{ _id: 'nested-reply', children: [] }] };
  const tree = [{ _id: 'root', children: [pinnedReply] }, { _id: 'other-root', children: [] }];

  const reordered = interactionController.movePinnedCommentToRoots(tree, 'pinned');

  assert.equal(reordered[0], pinnedReply);
  assert.equal(pinnedReply.isPinned, true);
  assert.deepEqual(pinnedReply.children.map((child) => child._id), ['nested-reply']);
  assert.deepEqual(reordered.slice(1).map((comment) => comment._id), ['root', 'other-root']);
});
