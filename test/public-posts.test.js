const test = require('node:test');
const assert = require('node:assert/strict');
const router = require('../src/routes/web');
const controller = require('../src/controllers/webController');
const Community = require('../src/models/Community');
const Post = require('../src/models/Post');
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
  assert.equal(response.data.total, 37);
  assert.equal(response.data.noIndex, true);
  assert.equal(response.data.canonicalUrl, 'https://crowdwide.example/posts?type=article');
  assert.equal(response.data.structuredData.mainEntity.itemListElement[0].url, 'https://crowdwide.example/posts/post-0');
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
  t.mock.method(Community, 'find', (filter) => {
    communityFilter = filter;
    return { distinct: () => Promise.resolve(['private-community']) };
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
    type(value) { this.contentType = value; return this; },
    send(value) { this.body = value; }
  };
  await controller.sitemap({}, response);

  assert.deepEqual(communityFilter, { isPrivate: true });
  assert.deepEqual(postFilter.community, { $nin: ['private-community'] });
  assert.equal(postFilter.status, 'published');
  assert.match(response.body, /https:\/\/crowdwide\.example\/posts\/public-1/);
  assert.match(response.body, /https:\/\/crowdwide\.example\/posts\?type=article/);
  assert.match(response.body, /<lastmod>2026-10-01T00:00:00\.000Z<\/lastmod>/);
});
