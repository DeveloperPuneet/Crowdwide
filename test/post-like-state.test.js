const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../src/models/User');
const Post = require('../src/models/Post');
const Comment = require('../src/models/Comment');
const webController = require('../src/controllers/webController');

const viewerId = 'viewer-1';
const posts = [
  { _id: 'liked-post', likes: [viewerId] },
  { _id: 'unliked-post', likes: ['someone-else'] }
];

function mockPageData(t, userData) {
  t.mock.method(User, 'findById', () => ({
    select() {
      return { lean: async () => userData };
    }
  }));
  t.mock.method(Post, 'find', () => {
    const query = {
      sort() { return this; },
      limit() { return this; },
      populate() { return this; },
      lean: async () => posts
    };
    return query;
  });
  t.mock.method(Post, 'aggregate', async () => []);
  t.mock.method(Comment, 'find', () => ({ distinct: async () => [] }));
}

const assertRenderedLikeState = (page, controller, userData) => test(`${page} marks posts liked by the current viewer`, async (t) => {
  mockPageData(t, userData);
  const res = { render(view, data) { this.view = view; this.data = data; } };

  await controller({ session: { user: { id: viewerId } } }, res);

  assert.deepEqual(res.data.posts.map((post) => post.liked), [true, false]);
});

assertRenderedLikeState('topics', webController.followedTopicsPage, { followedTopics: ['design'] });
assertRenderedLikeState('conversations', webController.conversationsPage, { followedDiscussions: [] });
assertRenderedLikeState('recently viewed', webController.recentlyViewedPage, { recentViews: [{ post: 'liked-post' }, { post: 'unliked-post' }] });
