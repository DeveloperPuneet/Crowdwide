const test = require('node:test');
const assert = require('node:assert/strict');
const Comment = require('../src/models/Comment');
const Community = require('../src/models/Community');
const Notification = require('../src/models/Notification');
const Post = require('../src/models/Post');
const User = require('../src/models/User');
const interactionController = require('../src/controllers/interactionController');

test('replying to a comment notifies the parent comment author', async (t) => {
  const post = {
    _id: 'post-1',
    author: 'post-author',
    community: null,
    commentsCount: 1,
    save: async () => {}
  };
  const reply = {
    _id: 'reply-1',
    toObject: () => ({ _id: 'reply-1', body: 'Thanks!' })
  };
  const parentLookup = t.mock.method(Comment, 'findOne', () => ({
    select: () => ({
      lean: async () => ({ author: 'parent-author' })
    })
  }));
  t.mock.method(Comment, 'create', async () => reply);
  t.mock.method(Post, 'findById', async () => post);
  t.mock.method(Community, 'exists', async () => null);
  t.mock.method(User, 'findById', (id) => ({
    select: () => ({
      lean: async () => id === 'commenter'
        ? { postingRestrictedUntil: null }
        : { notificationPreferences: { emailUnreadSummary: false } }
    })
  }));
  const notificationCreate = t.mock.method(Notification, 'create', async () => ({}));

  const req = {
    params: { id: 'post-1' },
    body: { body: 'Thanks!', parent: '0123456789abcdef01234567' },
    session: { user: { id: 'commenter', name: 'Reply Author' } },
    get: () => null
  };
  const res = {
    redirect(url) { this.url = url; }
  };

  await interactionController.comment(req, res);

  assert.deepEqual(parentLookup.mock.calls[0].arguments[0], {
    _id: '0123456789abcdef01234567',
    post: 'post-1'
  });
  assert.deepEqual(notificationCreate.mock.calls[0].arguments[0], {
    recipient: 'parent-author',
    actor: 'commenter',
    type: 'reply',
    message: 'replied to your comment.',
    post: 'post-1',
    community: null
  });
  assert.equal(res.url, '/dashboard#post-post-1');
});
