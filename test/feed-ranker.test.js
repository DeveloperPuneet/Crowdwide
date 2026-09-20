const test = require('node:test');
const assert = require('node:assert/strict');
const r = require('../src/utils/feedRanker');

const NOW = Date.parse('2026-09-20T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000);
let seq = 0;
const cand = (extra = {}) => ({ _id: `p${seq += 1}`, author: `a${seq}`, community: null, type: 'post', hashtags: [], createdAt: hoursAgo(2), counts: {}, bodyLength: 80, hasMedia: false, moderationStatus: 'unreviewed', moderationScore: 0, ...extra });
const ctx = (extra = {}) => ({ userId: 'me', now: NOW, following: new Set(), joined: new Set(), extended: new Set(), interests: new Map(), authorAffinity: new Map(), authors: new Map(), communityMembers: new Map(), ...extra });

test('discovery ratio is clamped to the 35-40% band', () => {
  assert.equal(r.resolveDiscoveryRatio(undefined), 0.375);
  assert.equal(r.resolveDiscoveryRatio('0.9'), 0.4);
  assert.equal(r.resolveDiscoveryRatio('0.05'), 0.35);
  assert.equal(r.resolveDiscoveryRatio('abc'), 0.375);
});

test('For you: every page of 16 has exactly 6 posts from outside the network', () => {
  const following = new Set(Array.from({ length: 40 }, (_, i) => `f${i}`));
  const candidates = [
    ...Array.from({ length: 40 }, (_, i) => cand({ author: `f${i}` })),
    ...Array.from({ length: 40 }, (_, i) => cand({ author: `s${i}` }))
  ];
  const feed = r.rankFeed(candidates, ctx({ following }), 'for-you', { limit: 64 });
  assert.equal(feed.length, 64);
  for (let page = 0; page < 4; page += 1) {
    const slice = feed.slice(page * 16, page * 16 + 16);
    assert.equal(slice.filter((item) => item.lane === 'discovery').length, 6, `page ${page + 1}`);
  }
});

test('a lane that runs dry is filled from the other one', () => {
  const onlyStrangers = r.rankFeed(Array.from({ length: 20 }, () => cand()), ctx(), 'for-you', { limit: 20 });
  assert.equal(onlyStrangers.length, 20);
  assert.ok(onlyStrangers.every((item) => item.lane === 'discovery'));
});

test('followed authors and joined communities are network; strangers are discovery', () => {
  const c = ctx({ following: new Set(['f']), joined: new Set(['c1']) });
  assert.equal(r.classifyPost(cand({ author: 'f' }), c).lane, 'network');
  assert.equal(r.classifyPost(cand({ community: 'c1' }), c).lane, 'network');
  assert.equal(r.classifyPost(cand({ author: 'me' }), c).reason, 'own');
  assert.equal(r.classifyPost(cand({ community: 'other' }), c).lane, 'discovery');
});

test('scoring: fresher, more engaged, interest-matching and new-voice posts rank higher', () => {
  const base = ctx({ maxHot: 5, interests: new Map([['cats', 1]]) });
  const score = (post, view) => r.scorePost(post, base, view).score;
  assert.ok(score(cand({ createdAt: hoursAgo(1) }), 'for-you') > score(cand({ createdAt: hoursAgo(48) }), 'for-you'));
  assert.ok(score(cand({ counts: { likes: 30, comments: 8 } }), 'for-you') > score(cand({}), 'for-you'));
  assert.ok(score(cand({ hashtags: ['cats'] }), 'for-you') > score(cand({ hashtags: ['dogs'] }), 'for-you'));
  const newcomer = { ...base, authors: new Map([['n', { ageDays: 2, followers: 0 }], ['v', { ageDays: 900, followers: 5000 }]]) };
  assert.ok(r.scorePost(cand({ author: 'n' }), newcomer, 'for-you').score > r.scorePost(cand({ author: 'v' }), newcomer, 'for-you').score);
});

test('growth boost needs a quality post', () => {
  assert.ok(r.growthBoost({ authorAgeDays: 1, authorFollowers: 0, qualifies: true }) > 0.9);
  assert.equal(r.growthBoost({ authorAgeDays: 1, authorFollowers: 0, qualifies: false }), 0);
  assert.equal(r.passesQualityBar(cand({ bodyLength: 5 })), false);
  assert.equal(r.passesQualityBar(cand({ moderationStatus: 'needs-review' })), false);
});

test('tabs: posts tabs include polls, articles tabs only articles, viral needs traction', () => {
  const mixed = [cand({ type: 'post' }), cand({ type: 'poll' }), cand({ type: 'article' })];
  assert.equal(r.rankFeed(mixed, ctx(), 'posts-new').length, 2);
  assert.equal(r.rankFeed(mixed, ctx(), 'articles-new').length, 1);
  const many = Array.from({ length: 30 }, (_, i) => cand({ counts: i < 20 ? { likes: 10 + i } : {} }));
  const viral = r.rankFeed(many, ctx(), 'posts-viral', { limit: 30 });
  assert.equal(viral.length, 20, 'posts without traction are left out when enough viral ones exist');
});

test('New tab is newest-first (new voices get a small head start)', () => {
  const posts = [cand({ createdAt: hoursAgo(10) }), cand({ createdAt: hoursAgo(1) }), cand({ createdAt: hoursAgo(5) })];
  const order = r.rankFeed(posts, ctx(), 'posts-new').map((item) => item.post._id);
  assert.deepEqual(order, [posts[1]._id, posts[2]._id, posts[0]._id]);
});

test('no author fills the screen: max 3 per author, never back-to-back when others exist', () => {
  const posts = [...Array.from({ length: 8 }, () => cand({ author: 'spammer', counts: { likes: 50 } })), ...Array.from({ length: 8 }, () => cand())];
  // 3 spammer posts + the 8 other authors fill the first 11 slots; the rest of the
  // spammer's posts are only used afterwards, when nothing else is left.
  const feed = r.rankFeed(posts, ctx(), 'for-you', { limit: 16 }).slice(0, 11);
  assert.ok(feed.filter((item) => item.post.author === 'spammer').length <= 3);
});

test('my community only keeps posts that live in a community', () => {
  const c = ctx({ joined: new Set(['c1']) });
  const feed = r.rankFeed([cand({ community: 'c1' }), cand({ community: null }), cand({ community: 'c9' })], c, 'my-community');
  assert.equal(feed.length, 2);
  assert.equal(feed.filter((item) => item.lane === 'network').length, 1);
});
