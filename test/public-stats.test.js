const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLineChart, niceCeil } = require('../src/utils/lineChart');
const Post = require('../src/models/Post');
const Community = require('../src/models/Community');
const stats = require('../src/services/publicStats');

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;

test('niceCeil rounds up to a readable axis maximum', () => {
  assert.equal(niceCeil(0.7), 1);
  assert.equal(niceCeil(3.2), 5);
  assert.equal(niceCeil(12), 20);
  assert.equal(niceCeil(87), 100);
});

test('buildLineChart maps values to coordinates and breaks the line on missing weeks', () => {
  const chart = buildLineChart({ labels: ['a', 'b', 'c', 'd'], series: [{ key: 'x', name: 'X', values: [1, 2, null, 4] }] });
  assert.equal(chart.max, 5);
  assert.equal(chart.hasData, true);
  assert.equal(chart.series[0].segments.length, 2, 'a null week splits the line');
  const [first] = chart.series[0].points;
  assert.equal(first.x, 40);
  assert.ok(first.y < chart.yBottom && first.y > chart.yTop);
  assert.equal(chart.series[0].points.at(-1).x, 600);
});

test('buildLineChart reports no data when every value is missing', () => {
  const chart = buildLineChart({ labels: ['a', 'b'], series: [{ key: 'x', name: 'X', values: [null, null] }] });
  assert.equal(chart.hasData, false);
});

function chain(result) { return { select: () => ({ lean: () => Promise.resolve(result) }) }; }

test('computeGrowthStats uses real post data, splits new vs established communities, and only public communities', async (t) => {
  const now = Date.now();
  const newCommunity = { _id: 'c-new', createdAt: new Date(now - 10 * DAY), membersCount: 12 };
  const oldCommunity = { _id: 'c-old', createdAt: new Date(now - 200 * DAY), membersCount: 80 };
  t.mock.method(Community, 'find', (filter) => {
    assert.deepEqual(filter, { isPrivate: { $ne: true } }, 'private communities must be excluded');
    return chain([newCommunity, oldCommunity]);
  });
  t.mock.method(Post, 'find', (filter) => {
    assert.equal(filter.status, 'published');
    assert.deepEqual(filter.community.$in, ['c-new', 'c-old']);
    return chain([
      { community: 'c-new', createdAt: new Date(now - 2 * DAY), viewsCount: 10 },
      { community: 'c-new', createdAt: new Date(now - 2 * DAY), viewsCount: 20 },
      { community: 'c-old', createdAt: new Date(now - 2 * DAY), viewsCount: 100 },
      { community: 'c-old', createdAt: new Date(now - 3 * WEEK), viewsCount: 50 }
    ]);
  });
  const result = await stats.computeGrowthStats(now);
  assert.equal(result.totals.posts, 4);
  assert.equal(result.totals.newCommunityPosts, 2);
  assert.equal(result.totals.establishedPosts, 2);
  const reachNew = result.reach.series.find((s) => s.key === 'crowdwide');
  assert.equal(reachNew.points.at(-1).value, 15, 'average of 10 and 20 views in the latest week');
  const reachOld = result.reach.series.find((s) => s.key === 'typical');
  assert.equal(reachOld.points.at(-1).value, 100);
  assert.equal(result.totals.intermediateCommunities, 1);
  assert.equal(result.totals.largeCommunities, 1);
  const large = result.size.series.find((s) => s.key === 'large');
  assert.equal(large.points.at(-1).value, 1, 'one post from the one large community in the latest week');
});

test('computeGrowthStats handles a brand-new site with no communities', async (t) => {
  t.mock.method(Community, 'find', () => chain([]));
  t.mock.method(Post, 'find', () => { throw new Error('should not query posts without communities'); });
  const result = await stats.computeGrowthStats(Date.now());
  assert.equal(result.reach.hasData, false);
  assert.equal(result.size.hasData, false);
  assert.equal(result.totals.posts, 0);
});
