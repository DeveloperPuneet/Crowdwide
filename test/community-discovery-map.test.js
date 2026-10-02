const test = require('node:test');
const assert = require('node:assert/strict');
const Community = require('../src/models/Community');
const communityController = require('../src/controllers/communityController');
const router = require('../src/routes/web');

const findRoute = (path) => router.stack.find((layer) => layer.route?.path === path)?.route;

test('community map route is registered before the dynamic community page route', () => {
  const mapIndex = router.stack.findIndex((layer) => layer.route?.path === '/community-map');
  const detailIndex = router.stack.findIndex((layer) => layer.route?.path === '/communities/:slug');
  assert.ok(mapIndex >= 0);
  assert.ok(detailIndex >= 0);
  assert.ok(mapIndex < detailIndex);
});

test('community map only queries public, opted-in communities with valid coordinate bounds', async (t) => {
  let query;
  const communities = [{ _id: 'c1', name: 'Map Makers', slug: 'map-makers', isPrivate: false, showOnMap: true, locationLabel: 'London, UK', locationLat: 51.5, locationLng: -0.1 }];
  t.mock.method(Community, 'find', (filter) => {
    query = filter;
    return { sort: () => ({ limit: () => ({ select: () => ({ lean: () => Promise.resolve(communities) }) }) }) };
  });
  t.mock.method(Community, 'distinct', () => Promise.resolve(['creative', 'learning']));
  const res = { render(view, data) { this.view = view; this.data = data; } };

  await communityController.communityMap({ query: {} }, res);

  assert.equal(query.isPrivate, false);
  assert.equal(query.showOnMap, true);
  assert.deepEqual(query.locationLat, { $gte: -90, $lte: 90 });
  assert.deepEqual(query.locationLng, { $gte: -180, $lte: 180 });
  assert.equal(res.view, 'pages/community-map');
  assert.deepEqual(res.data.mapCommunities, communities);
  assert.deepEqual(res.data.categories, ['creative', 'learning']);
});

test('community radar route is registered and ranks communities by recent activity', async (t) => {
  const route = router.stack.find((layer) => layer.route?.path === '/communities/rising');
  assert.ok(route, 'the rising communities route should exist');

  const communities = [
    { _id: 'c1', name: 'Rising Readers', slug: 'rising-readers', description: 'Book lovers', category: 'learning', hashtags: ['books'], membersCount: 120, avatarImage: '', createdAt: new Date('2025-01-10') },
    { _id: 'c2', name: 'Quiet Makers', slug: 'quiet-makers', description: 'Makers', category: 'creative', hashtags: ['design'], membersCount: 30, avatarImage: '', createdAt: new Date('2025-01-18') }
  ];

  t.mock.method(Community, 'find', () => ({
    select: () => ({ sort: () => ({ lean: () => Promise.resolve(communities) }) })
  }));
  t.mock.method(Community, 'distinct', () => Promise.resolve(['learning', 'creative']));
  t.mock.method(require('../src/models/Post'), 'aggregate', () => Promise.resolve([
    { _id: 'c1', count: 9, likes: 28, commentSignals: 6, shares: 4, views: 120 },
    { _id: 'c2', count: 4, likes: 12, commentSignals: 3, shares: 2, views: 60 }
  ]));

  const res = { render(view, data) { this.view = view; this.data = data; } };
  await communityController.risingCommunities({ session: { user: { id: 'u1' } } }, res);

  assert.equal(res.view, 'pages/rising-communities');
  assert.ok(Array.isArray(res.data.risingCommunities));
  assert.equal(res.data.risingCommunities[0].slug, 'rising-readers');
  assert.ok(res.data.risingCommunities[0].score > res.data.risingCommunities[1].score);
});
