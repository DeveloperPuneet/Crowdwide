const test = require('node:test');
const assert = require('node:assert/strict');
const Post = require('../src/models/Post');
const Community = require('../src/models/Community');
const { apiPosts } = require('../src/controllers/webController');

function fakeRes() {
  const res = { headers: {} };
  res.set = (key, value) => { res.headers[key] = value; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.status = (code) => { res.statusCode = code; return res; };
  return res;
}

function mockPostFind(t, posts) {
  return t.mock.method(Post, 'find', () => ({
    sort: () => ({
      limit: () => ({
        populate: () => ({
          populate: () => ({ lean: () => Promise.resolve(posts) })
        })
      })
    })
  }));
}

test('apiPosts clamps an out-of-range limit to the documented 1-50 bounds', async (t) => {
  t.mock.method(Community, 'find', () => ({ distinct: () => Promise.resolve([]) }));
  const limitCalls = [];
  t.mock.method(Post, 'find', () => ({
    sort: () => ({
      limit: (n) => {
        limitCalls.push(n);
        return { populate: () => ({ populate: () => ({ lean: () => Promise.resolve([]) }) }) };
      }
    })
  }));
  await apiPosts({ query: { limit: '9999' } }, fakeRes());
  assert.equal(limitCalls[0], 50);

  await apiPosts({ query: { limit: '0' } }, fakeRes());
  assert.equal(limitCalls[1], 1);

  await apiPosts({ query: {} }, fakeRes());
  assert.equal(limitCalls[2], 20);
});

test('apiPosts sets Access-Control-Allow-Origin: * (CORS-open, as documented)', async (t) => {
  t.mock.method(Community, 'find', () => ({ distinct: () => Promise.resolve([]) }));
  mockPostFind(t, []);
  const res = fakeRes();
  await apiPosts({ query: {} }, res);
  assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
});

test('apiPosts silently ignores an invalid community param instead of erroring', async (t) => {
  t.mock.method(Community, 'find', () => ({ distinct: () => Promise.resolve([]) }));
  const findCalls = mockPostFind(t, []);
  const res = fakeRes();
  await apiPosts({ query: { community: 'not-a-valid-object-id' } }, res);
  assert.equal(res.statusCode, undefined); // no error status set
  const filterUsed = findCalls.mock.calls[0].arguments[0];
  assert.ok(!('community' in filterUsed) || typeof filterUsed.community === 'object'); // fell back to the $nin-restricted filter, not the raw string
});

test('apiPosts returns an empty page for a private community ID without querying posts at all', async (t) => {
  const privateId = '507f1f77bcf86cd799439011';
  t.mock.method(Community, 'find', () => ({ distinct: () => Promise.resolve([privateId]) }));
  const findCalls = t.mock.method(Post, 'find');
  const res = fakeRes();
  await apiPosts({ query: { community: privateId } }, res);
  assert.deepEqual(res.body, { data: [], nextCursor: null });
  assert.equal(findCalls.mock.callCount(), 0);
});

test('apiPosts sets nextCursor to the last item\'s createdAt only when a full page came back', async (t) => {
  t.mock.method(Community, 'find', () => ({ distinct: () => Promise.resolve([]) }));
  const posts = [
    { _id: 'p1', body: 'a', type: 'post', author: {}, community: null, hashtags: [], media: [], createdAt: new Date('2026-01-02') },
    { _id: 'p2', body: 'b', type: 'post', author: {}, community: null, hashtags: [], media: [], createdAt: new Date('2026-01-01') }
  ];
  mockPostFind(t, posts);
  const res = fakeRes();
  await apiPosts({ query: { limit: '2' } }, res);
  assert.deepEqual(res.body.nextCursor, new Date('2026-01-01'));
});

test('apiPosts sets nextCursor to null when fewer results than the limit came back (last page)', async (t) => {
  t.mock.method(Community, 'find', () => ({ distinct: () => Promise.resolve([]) }));
  mockPostFind(t, [{ _id: 'p1', body: 'a', type: 'post', author: {}, community: null, hashtags: [], media: [], createdAt: new Date() }]);
  const res = fakeRes();
  await apiPosts({ query: { limit: '20' } }, res);
  assert.equal(res.body.nextCursor, null);
});

test('apiPosts returns a 500 with the documented error shape on an internal failure, not a hang or crash', async (t) => {
  t.mock.method(Community, 'find', () => { throw new Error('database unavailable'); });
  const res = fakeRes();
  await apiPosts({ query: {} }, res);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'Internal server error.' });
});
