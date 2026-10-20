const test = require('node:test');
const assert = require('node:assert/strict');
const { selectAds, scoreCampaign, contextTerms, relevanceOf } = require('../src/services/adRanker');

const base = (over = {}) => ({ _id: String(Math.random()), advertiser: String(Math.random()), title: 'Ad', description: '', keywords: [], totalBudget: 100, remainingBudget: 80, impressions: 100, clicks: 2, targetCommunities: [], ...over });
const ctx = { name: 'Street photography', category: 'art', hashtags: ['photography', 'camera'], description: 'Share your photos' };

test('relevant keywords score higher than unrelated ones', () => {
  const terms = contextTerms(ctx);
  assert.ok(relevanceOf(base({ keywords: ['photography', 'cameras'] }), terms) > relevanceOf(base({ keywords: ['mortgage'] }), terms));
});
test('exhausted budget or hit daily cap is never selected', () => {
  const terms = contextTerms(ctx);
  assert.equal(scoreCampaign(base({ remainingBudget: 0 }), { terms }), 0);
  assert.equal(scoreCampaign(base({ dailyBudget: 5, dailyBudgetSpent: 5, dailyBudgetDate: new Date() }), { terms }), 0);
});
test('seen ads are penalised and one ad per advertiser is chosen', () => {
  const terms = contextTerms(ctx);
  const a = base({ keywords: ['photography'] });
  const seen = new Map([[String(a._id), 3]]);
  assert.ok(scoreCampaign(a, { terms, seen }) < scoreCampaign(a, { terms }));
  const adv = 'same';
  const picked = selectAds([base({ advertiser: adv }), base({ advertiser: adv }), base()], { context: ctx, limit: 3 });
  assert.equal(new Set(picked.map((c) => String(c.advertiser))).size, picked.length);
});
test('high-relevance ad wins most draws', () => {
  const good = base({ keywords: ['photography', 'camera'] });
  const bad = base({ keywords: ['mortgage'] });
  let goodWins = 0;
  for (let i = 0; i < 400; i += 1) if (selectAds([good, bad], { context: ctx, limit: 1 })[0] === good) goodWins += 1;
  assert.ok(goodWins > 220, `good ad won only ${goodWins}/400`);
});
test('explicitly targeted campaigns get a boost over generic ones', () => {
  const terms = contextTerms(ctx);
  const generic = base();
  assert.ok(scoreCampaign({ ...generic, targetCommunities: ['c1'] }, { terms }) > scoreCampaign(generic, { terms }));
});
