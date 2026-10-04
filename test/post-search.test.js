const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSearchRequest, toSearchDocument } = require('../src/services/postSearch');

test('post search index documents contain searchable text and filter fields, not private post details', () => {
  const document = toSearchDocument({
    _id: 'p1',
    body: 'React hook patterns',
    hashtags: ['react'],
    author: 'u1',
    community: null,
    type: 'article',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    commentsCount: 2,
    likes: ['u2', 'u3'],
    media: [{ url: '/private-media' }],
    contentWarning: 'private warning'
  });

  assert.deepEqual(document, {
    id: 'p1',
    body: 'React hook patterns',
    hashtags: ['react'],
    author: 'u1',
    community: 'open',
    type: 'article',
    createdAt: 1767225600,
    commentsCount: 2,
    likesCount: 2,
    hasMedia: true
  });
});

test('Meilisearch queries support relevance ranking and constrain results to allowed post filters', () => {
  const search = buildSearchRequest({
    query: 'Reakt hooks',
    filters: {
      tag: null,
      type: 'article',
      community: 'c1',
      media: true,
      unanswered: true,
      from: new Date('2026-01-01T00:00:00Z'),
      to: new Date('2026-01-31T23:59:59Z'),
      blockedAuthors: ['u1'],
      mutedAuthors: ['u2', 'u1'],
      restrictedCommunities: ['c2']
    }
  });

  assert.equal(search.q, 'Reakt hooks');
  assert.equal(search.limit, 1000);
  assert.equal(search.sort, undefined, 'the default ordering should be Meilisearch relevance');
  assert.deepEqual(search.filter, [
    'author NOT IN ["u1", "u2"]',
    'community NOT IN ["c2"]',
    'type = "article"',
    'community = "c1"',
    'hasMedia = true',
    'commentsCount = 0',
    'createdAt >= 1767225600',
    'createdAt <= 1769903999'
  ]);
});

test('hashtag search uses an exact tag filter and supports explicit sort choices', () => {
  const search = buildSearchRequest({
    query: '',
    filters: { tag: 'react', sort: 'popular' }
  });

  assert.equal(search.q, '');
  assert.deepEqual(search.filter, ['hashtags = "react"']);
  assert.deepEqual(search.sort, ['likesCount:desc', 'commentsCount:desc', 'createdAt:desc']);
});

test('configured Meilisearch returns matching post IDs and authenticates requests', async (t) => {
  const originalUrl = process.env.MEILISEARCH_URL;
  const originalKey = process.env.MEILISEARCH_API_KEY;
  process.env.MEILISEARCH_URL = 'http://meilisearch.test';
  process.env.MEILISEARCH_API_KEY = 'test-key';
  t.after(() => {
    if (originalUrl === undefined) delete process.env.MEILISEARCH_URL;
    else process.env.MEILISEARCH_URL = originalUrl;
    if (originalKey === undefined) delete process.env.MEILISEARCH_API_KEY;
    else process.env.MEILISEARCH_API_KEY = originalKey;
  });
  const requests = [];
  t.mock.method(global, 'fetch', async (url, options = {}) => {
    requests.push({ url: new URL(url), options });
    let body = {};
    if (url.pathname === '/indexes/posts/search') body = { hits: [{ id: 'post-1' }] };
    else if (url.pathname.startsWith('/indexes/posts/settings/')) body = { taskUid: requests.length };
    else if (url.pathname.startsWith('/tasks/')) body = { status: 'succeeded' };
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify(body)
    };
  });

  const { searchPublishedPosts } = require('../src/services/postSearch');
  const results = await searchPublishedPosts({ query: 'Reakt hooks', filters: { sort: 'relevance' } });
  assert.deepEqual(requests.map(({ url }) => url.pathname), [
    '/indexes/posts',
    '/indexes/posts/settings/filterable-attributes',
    '/tasks/2',
    '/indexes/posts/settings/sortable-attributes',
    '/tasks/4',
    '/indexes/posts/search'
  ]);
  assert.deepEqual(results, ['post-1']);
  assert.ok(requests.every(({ options }) => options.headers.Authorization === 'Bearer test-key'));
  const searchRequest = requests.find(({ url }) => url.pathname === '/indexes/posts/search');
  assert.deepEqual(JSON.parse(searchRequest.options.body), {
    q: 'Reakt hooks',
    limit: 1000
  });
});
