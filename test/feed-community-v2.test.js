const test = require('node:test');
const assert = require('node:assert/strict');
const ranker = require('../src/utils/feedRanker');
const { rankCommunities } = require('../src/services/communityRecommendations');
const { icon } = require('../src/utils/icons');

const base = { author: 'a', createdAt: new Date(), counts: {}, bodyLength: 80, type: 'post', hashtags: [] };
const ctx = () => ({ userId: 'u', now: Date.now(), following: new Set(), joined: new Set(), extended: new Set(), interests: new Map(), authorAffinity: new Map(), authors: new Map(), communityMembers: new Map(), maxHot: 1, maxViral: 1 });

test('instagram icon exists', () => {
  assert.match(String(icon('instagram')), /<svg/);
});

test('posts the reader already opened rank lower in For you', () => {
  const c = ctx();
  c.seen = new Set(['p1']);
  const fresh = ranker.scorePost({ ...base, _id: 'p2' }, c, 'for-you');
  const seen = ranker.scorePost({ ...base, _id: 'p1' }, c, 'for-you');
  assert.ok(seen.score < fresh.score);
});

test('resonance rewards action per view and is smoothed', () => {
  assert.equal(ranker.resonance({ likes: 0, views: 100 }), 0);
  assert.ok(ranker.resonance({ likes: 20, comments: 5, views: 60 }) > ranker.resonance({ likes: 1, views: 1 }) );
  assert.ok(ranker.resonance({ likes: 20, views: 40 }) > ranker.resonance({ likes: 20, views: 4000 }));
});

test('diversify avoids the same topic back-to-back when alternatives exist, but still shows everything', () => {
  const mk = (id, author, tag, score) => ({ post: { _id: id, author, hashtags: [tag] }, score });
  const out = ranker.diversify([mk(1, 'a', 'x', 9), mk(2, 'b', 'x', 8), mk(3, 'c', 'y', 7), mk(4, 'd', 'x', 6)]);
  assert.equal(out.length, 4);
  assert.notEqual(out[0].post.hashtags[0], out[1].post.hashtags[0]);
});

test('communities: top 5, interest matches first, popular fill the rest', () => {
  const list = [];
  for (let i = 0; i < 8; i += 1) list.push({ _id: `p${i}`, name: `Pop ${i}`, description: 'general chat', category: 'general', hashtags: [], membersCount: 1000 - i });
  list.push({ _id: 'm1', name: 'Rust folks', description: 'systems', category: 'technology', hashtags: ['rust'], membersCount: 5 });
  list.push({ _id: 'm2', name: 'Chess club', description: 'boards', category: 'gaming', hashtags: ['chess'], membersCount: 3 });
  const out = rankCommunities(list, { interests: new Map([['rust', 1], ['chess', 0.5]]), favouriteCategories: new Set(['technology']), limit: 5 });
  assert.equal(out.length, 5);
  assert.deepEqual(out.slice(0, 2).map((c) => c._id), ['m1', 'm2']);
  assert.equal(out[2]._id, 'p0');
});

test('communities: no interests falls back to popularity', () => {
  const out = rankCommunities([{ _id: 'a', membersCount: 1 }, { _id: 'b', membersCount: 50 }], {});
  assert.equal(out[0]._id, 'b');
});
