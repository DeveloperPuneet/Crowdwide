const test = require('node:test');
const assert = require('node:assert/strict');
const Community = require('../src/models/Community');
const Post = require('../src/models/Post');
const { canAccessPost } = require('../src/controllers/interactionController');

test('canAccessPost returns false for a null/missing post', async () => {
  assert.equal(await canAccessPost(null, 'u1'), false);
});

test('postDetail returns 404 for an invalid post ID without querying Post', async (t) => {
  const findOne = t.mock.method(Post, 'findOne');
  const response = {
    status(code) {
      this.statusCode = code;
      return this;
    },
    render(view, locals) {
      this.view = view;
      this.locals = locals;
      return this;
    }
  };

  await require('../src/controllers/interactionController').postDetail(
    { params: { id: 'null' }, session: {} },
    response
  );

  assert.equal(response.statusCode, 404);
  assert.equal(response.view, 'pages/not-found');
  assert.equal(findOne.mock.callCount(), 0);
});

test('post edit and reply pages return 404 for invalid post IDs without querying Post', async (t) => {
  const findOne = t.mock.method(Post, 'findOne');
  const findById = t.mock.method(Post, 'findById');
  const controller = require('../src/controllers/interactionController');
  const createResponse = () => ({
    status(code) {
      this.statusCode = code;
      return this;
    },
    render(view) {
      this.view = view;
      return this;
    }
  });

  for (const handler of [controller.editPostPage, controller.replyPostPage]) {
    const response = createResponse();
    await handler({ params: { id: 'null' }, session: {} }, response);
    assert.equal(response.statusCode, 404);
    assert.equal(response.view, 'pages/not-found');
  }

  assert.equal(findOne.mock.callCount(), 0);
  assert.equal(findById.mock.callCount(), 0);
});

test('commentThread returns an empty 404 response for an invalid post ID without querying Post', async (t) => {
  const findById = t.mock.method(Post, 'findById');
  const response = {
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };

  await require('../src/controllers/interactionController').commentThread(
    { params: { id: 'null' }, session: {} },
    response
  );

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, { comments: [] });
  assert.equal(findById.mock.callCount(), 0);
});

test('canAccessPost allows a published post with no community, without querying Community at all', async (t) => {
  const existsCalls = t.mock.method(Community, 'exists');
  const result = await canAccessPost({ status: 'published', author: 'u2', community: null }, 'u1');
  assert.equal(result, true);
  assert.equal(existsCalls.mock.callCount(), 0);
});

test('canAccessPost blocks a draft post for anyone but its author', async () => {
  const result = await canAccessPost({ status: 'draft', author: 'u2', community: null }, 'u1');
  assert.equal(result, false);
});

test('canAccessPost allows a draft post for its own author', async () => {
  const result = await canAccessPost({ status: 'draft', author: 'u1', community: null }, 'u1');
  assert.equal(result, true);
});

test('canAccessPost blocks a scheduled post for anyone but its author', async () => {
  const result = await canAccessPost({ status: 'scheduled', author: 'u2', community: null }, 'u1');
  assert.equal(result, false);
});

test('canAccessPost keeps pending and rejected posts private to their author', async () => {
  for (const status of ['pending', 'rejected']) {
    assert.equal(await canAccessPost({ status, author: 'u2', community: null }, 'u1'), false);
    assert.equal(await canAccessPost({ status, author: 'u1', community: null }, 'u1'), true);
  }
});

test('canAccessPost blocks a post in a private community the viewer has not joined (the core fix)', async (t) => {
  t.mock.method(Community, 'exists', () => Promise.resolve(true));
  const result = await canAccessPost({ status: 'published', author: 'u2', community: 'c1' }, 'u1');
  assert.equal(result, false);
});

test('canAccessPost allows a post in a private community the viewer HAS joined', async (t) => {
  // Community.exists({ isPrivate: true, members: { $ne: userId } }) correctly
  // resolves falsy when the viewer IS in members - simulate that here.
  t.mock.method(Community, 'exists', () => Promise.resolve(null));
  const result = await canAccessPost({ status: 'published', author: 'u2', community: 'c1' }, 'u1');
  assert.equal(result, true);
});

test('canAccessPost allows a post in a public (non-private) community for a non-member', async (t) => {
  t.mock.method(Community, 'exists', () => Promise.resolve(null)); // isPrivate:true condition never matches a public community
  const result = await canAccessPost({ status: 'published', author: 'u2', community: 'c1' }, 'u1');
  assert.equal(result, true);
});

test('canAccessPost blocks an anonymous (logged-out) viewer from any private-community post', async (t) => {
  const existsCalls = t.mock.method(Community, 'exists', ({ members }) => {
    // members: { $ne: undefined } should behave as "always true" for a
    // real private community, since no member ID ever equals undefined.
    assert.deepEqual(members, { $ne: undefined });
    return Promise.resolve(true);
  });
  const result = await canAccessPost({ status: 'published', author: 'u2', community: 'c1' }, undefined);
  assert.equal(result, false);
  assert.equal(existsCalls.mock.callCount(), 1);
});

test('canAccessPost checks community using the exact community/isPrivate/members query shape', async (t) => {
  const existsCalls = t.mock.method(Community, 'exists', () => Promise.resolve(false));
  await canAccessPost({ status: 'published', author: 'u2', community: 'c1' }, 'u1');
  assert.deepEqual(existsCalls.mock.calls[0].arguments[0], { _id: 'c1', isPrivate: true, members: { $ne: 'u1' } });
});
