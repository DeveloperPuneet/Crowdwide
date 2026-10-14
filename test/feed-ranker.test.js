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

test('Viral never falls back to untouched posts, so it differs from New on a quiet platform', () => {
  // Regression: with fewer than a page of engaged posts, Viral used to include
  // everything and order it by freshness - the same list as "New".
  const quiet = [
    cand({ createdAt: hoursAgo(1) }),
    cand({ createdAt: hoursAgo(2) }),
    cand({ createdAt: hoursAgo(30), counts: { likes: 9, comments: 2 } }),
    cand({ createdAt: hoursAgo(3), counts: { likes: 1 } })
  ];
  const newIds = r.rankFeed(quiet, ctx(), 'posts-new').map((item) => item.post._id);
  const viralIds = r.rankFeed(quiet, ctx(), 'posts-viral').map((item) => item.post._id);
  assert.equal(newIds.length, 4);
  assert.deepEqual(viralIds, [quiet[2]._id], 'only the post with real traction is viral');
  assert.notDeepEqual(viralIds, newIds);
  assert.deepEqual(r.rankFeed(quiet.slice(0, 2), ctx(), 'posts-viral'), [], 'nothing viral -> empty tab, not a copy of New');
  assert.deepEqual(r.rankFeed(quiet.slice(0, 2), ctx(), 'articles-viral'), []);
});

test('Viral orders by decayed engagement, New by recency', () => {
  const older = cand({ createdAt: hoursAgo(20), counts: { likes: 60, comments: 10 } });
  const newer = cand({ createdAt: hoursAgo(1), counts: { likes: 2 } });
  const viral = r.rankFeed([newer, older], ctx(), 'posts-viral').map((item) => item.post._id);
  const fresh = r.rankFeed([newer, older], ctx(), 'posts-new').map((item) => item.post._id);
  assert.deepEqual(viral, [older._id, newer._id]);
  assert.deepEqual(fresh, [newer._id, older._id]);
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

test('New is strictly newest-first inside every page even though the outside-network quota picks the posts', () => {
  // Regression: the quota used to pull older outside posts ahead of newer
  // network posts, so "New" was not in time order.
  const following = new Set(['f1', 'f2']);
  const posts = [
    cand({ author: 'f1', createdAt: hoursAgo(1) }), cand({ author: 'f2', createdAt: hoursAgo(3) }), cand({ author: 'f1', createdAt: hoursAgo(5) }),
    cand({ author: 'x1', createdAt: hoursAgo(2) }), cand({ author: 'x2', createdAt: hoursAgo(4) }), cand({ author: 'x3', createdAt: hoursAgo(6) }),
    cand({ author: 'x4', createdAt: hoursAgo(7) }), cand({ author: 'x5', createdAt: hoursAgo(8) })
  ];
  const feed = r.rankFeed(posts, ctx({ following }), 'posts-new');
  const ages = feed.map((item) => Math.round((NOW - item.post.createdAt) / 3600000));
  assert.deepEqual(ages, ages.slice().sort((a, b) => a - b), 'newest first');
  assert.ok(feed.slice(0, 8).filter((item) => item.lane === 'discovery').length >= 3, 'outside-network share is still guaranteed');
});

test('Viral counts real interactions only - opened-a-lot posts are not viral', () => {
  const viewedOnly = cand({ counts: { views: 400 } });
  const liked = cand({ counts: { likes: 2 } });
  assert.equal(r.interactionPoints({ likes: 2, views: 400 }), 2);
  assert.deepEqual(r.rankFeed([viewedOnly, liked], ctx(), 'posts-viral').map((item) => item.post._id), [liked._id]);
});

test('Viral keeps a big older hit above a tiny fresh post', () => {
  const bigOld = cand({ createdAt: hoursAgo(70), counts: { likes: 60, comments: 20, shares: 5 } });
  const tinyFresh = cand({ createdAt: hoursAgo(1.5), counts: { likes: 2 } });
  const mid = cand({ createdAt: hoursAgo(10), counts: { likes: 8, comments: 2 } });
  assert.deepEqual(r.rankFeed([tinyFresh, mid, bigOld], ctx(), 'posts-viral').map((item) => item.post._id), [bigOld._id, mid._id, tinyFresh._id]);
});

test('Viral lifts small-reach authors: same traction, the newcomer ranks higher', () => {
  const newcomer = cand({ author: 'n', counts: { likes: 6 } });
  const veteran = cand({ author: 'v', counts: { likes: 6 } });
  const authors = new Map([['n', { ageDays: 3, followers: 0 }], ['v', { ageDays: 900, followers: 4000 }]]);
  assert.deepEqual(r.rankFeed([veteran, newcomer], ctx({ authors }), 'posts-viral').map((item) => item.post._id), [newcomer._id, veteran._id]);
});

test('first look: a fresh, untouched quality post is boosted, and the boost ends once it has interactions', () => {
  const c = ctx({ maxHot: 5 });
  const untouched = r.scorePost(cand({ createdAt: hoursAgo(1) }), c, 'for-you');
  const reacted = r.scorePost(cand({ createdAt: hoursAgo(1), counts: { likes: 3 } }), c, 'for-you');
  assert.ok(untouched.parts.look > 0.8);
  assert.equal(reacted.parts.look, 0);
  assert.equal(r.scorePost(cand({ createdAt: hoursAgo(1), bodyLength: 4 }), c, 'for-you').parts.look, 0, 'junk gets no first look');
  assert.ok(r.scorePost(cand({ createdAt: hoursAgo(40) }), c, 'for-you').parts.look < 0.02, 'fades with age');
});

test('discovery lane caps one community so small ones are not crowded out', () => {
  const posts = [
    ...Array.from({ length: 10 }, (_, i) => cand({ community: 'big', createdAt: hoursAgo(1 + i * 0.1) })),
    cand({ community: 'tiny1', createdAt: hoursAgo(5) }), cand({ community: 'tiny2', createdAt: hoursAgo(6) }), cand({ community: 'tiny3', createdAt: hoursAgo(7) })
  ];
  const feed = r.rankFeed(posts, ctx(), 'for-you', { limit: 16 });
  const firstSeven = feed.slice(0, 6).map((item) => item.post.community);
  assert.ok(firstSeven.filter((community) => community === 'big').length <= 3);
  assert.ok(['tiny1', 'tiny2', 'tiny3'].every((community) => firstSeven.includes(community)));
});

test('sortWithinPages only reorders inside a page', () => {
  const items = [3, 9, 5, 1].map((score) => ({ score }));
  assert.deepEqual(r.sortWithinPages(items, 2).map((item) => item.score), [9, 3, 5, 1]);
});
