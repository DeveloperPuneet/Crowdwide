const test = require('node:test');
const assert = require('node:assert/strict');
const router = require('../src/routes/web');
const controller = require('../src/controllers/webController');
const Community = require('../src/models/Community');
const Post = require('../src/models/Post');
const User = require('../src/models/User');
const { requireAuth } = require('../src/middleware/auth');

test('public post listing is unauthenticated and registered before post detail', () => {
  const listingIndex = router.stack.findIndex((layer) => layer.route?.path === '/posts' && layer.route.methods.get);
  const detailIndex = router.stack.findIndex((layer) => layer.route?.path === '/posts/:id' && layer.route.methods.get);

  assert.ok(listingIndex >= 0);
  assert.ok(detailIndex > listingIndex);
  assert.equal(router.stack[listingIndex].route.stack.length, 1);
  for (const path of ['/posts/:id/like', '/posts/:id/poll/vote', '/posts/:id/comments']) {
    const interaction = router.stack.find((layer) => layer.route?.path === path && layer.route.methods.post);
    assert.ok(interaction, `${path} should remain a route`);
    assert.ok(interaction.route.stack.some((handler) => handler.handle === requireAuth), `${path} should require sign-in`);
  }
});

test('public post listing filters by type, pages results, and provides collection SEO data', async (t) => {
  const posts = Array.from({ length: 21 }, (_, index) => ({
    _id: `post-${index}`,
    type: 'article',
    body: `Article ${index}`,
    author: { _id: `author-${index}`, name: `Author ${index}` },
    likes: [],
    createdAt: new Date('2026-10-01T00:00:00Z')
  }));
  let communityFilter;
  let postFilter;
  let postQuery;
  t.mock.method(User, 'find', () => ({ distinct: async () => [] }));
  t.mock.method(Community, 'find', (filter) => {
    communityFilter = filter;
    return { distinct: () => Promise.resolve(['private-community']) };
  });
  t.mock.method(Post, 'find', (filter) => {
    postFilter = filter;
    postQuery = {
      sort(value) { this.sortValue = value; return this; },
      skip(value) { this.skipValue = value; return this; },
      limit(value) { this.limitValue = value; return this; },
      populate() { return this; },
      lean() { return Promise.resolve(posts); }
    };
    return postQuery;
  });
  t.mock.method(Post, 'countDocuments', () => Promise.resolve(37));

  const response = {
    locals: { appUrl: 'https://crowdwide.example/' },
    render(view, data) { this.view = view; this.data = data; }
  };
  await controller.publicPosts({ query: { type: 'article', page: '2' }, session: {} }, response);

  assert.deepEqual(communityFilter, { isPrivate: true });
  assert.equal(postFilter.type, 'article');
  assert.deepEqual(postFilter.community, { $nin: ['private-community'] });
  assert.equal(postFilter.status, 'published');
  assert.equal(postFilter.moderationStatus.$ne, 'reported');
  assert.equal(postQuery.skipValue, 20);
  assert.equal(postQuery.limitValue, 21);
  assert.equal(response.view, 'pages/public-posts');
  assert.equal(response.data.posts.length, 20);
  assert.ok(response.data.thirdPartyFeedAdAfter >= 14 && response.data.thirdPartyFeedAdAfter <= 19);
  assert.equal(response.data.total, 37);
  assert.equal(response.data.noIndex, true);
  assert.equal(response.data.canonicalUrl, 'https://crowdwide.example/posts?type=article');
  assert.equal(response.data.structuredData.mainEntity.itemListElement[0].url, 'https://crowdwide.example/posts/post-0');

  response.locals.currentUser = { adFreeUntil: new Date(Date.now() + 60_000) };
  await controller.publicPosts({ query: { type: 'article', page: '2' }, session: {} }, response);
  assert.equal(response.data.thirdPartyFeedAdAfter, 0);
});

test('sitemap includes public post URLs but excludes private community posts at query time', async (t) => {
  const originalAppUrl = process.env.APP_URL;
  process.env.APP_URL = 'https://crowdwide.example/';
  t.after(() => {
    if (originalAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = originalAppUrl;
  });
  let communityFilter;
  let postFilter;
  t.mock.method(User, 'find', (filter) => {
    if (filter?.privacy === 'public') {
      return {
        sort() { return this; }, limit() { return this; }, select() { return this; },
        lean: async () => [{ _id: 'public-user', updatedAt: new Date('2026-10-02T00:00:00Z') }]
      };
    }
    return { distinct: async () => [] };
  });
  t.mock.method(Community, 'find', (filter) => {
    communityFilter = filter;
    if (filter?.isPrivate === true) return { distinct: () => Promise.resolve(['private-community']) };
    return {
      sort() { return this; }, limit() { return this; }, select() { return this; },
      lean: async () => [{ slug: 'public-community', updatedAt: new Date('2026-10-03T00:00:00Z') }]
    };
  });
  t.mock.method(Post, 'find', (filter) => {
    postFilter = filter;
    return {
      sort() { return this; },
      limit() { return this; },
      select() { return this; },
      lean() { return Promise.resolve([{ _id: 'public-1', updatedAt: new Date('2026-10-01T00:00:00Z') }]); }
    };
  });
  const response = {
    set(name, value) { this.headers ||= {}; this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    type(value) { this.contentType = value; return this; },
    send(value) { this.body = value; return this; }
  };
  await controller.sitemap({}, response);

  assert.deepEqual(communityFilter, { isPrivate: false });
  assert.deepEqual(postFilter.community, { $nin: ['private-community'] });
  assert.equal(postFilter.status, 'published');
  assert.match(response.body, /https:\/\/crowdwide\.example\/posts\/public-1/);
  assert.match(response.body, /https:\/\/crowdwide\.example\/u\/public-user/);
  assert.match(response.body, /https:\/\/crowdwide\.example\/communities\/public-community/);
  assert.match(response.body, /https:\/\/crowdwide\.example\/posts\?type=article/);
  assert.match(response.body, /<lastmod>2026-10-01T00:00:00\.000Z<\/lastmod>/);
});
