const test = require('node:test');
const assert = require('node:assert/strict');
const { NEWSLETTER_CRON, buildNewsletterSelection } = require('../src/services/newsletterWorker');
const User = require('../src/models/User');

test('newsletter delivery is scheduled Sunday at 10:30 and email options default on', () => {
  assert.equal(NEWSLETTER_CRON, '30 10 * * 0');
  assert.equal(User.schema.path('notificationPreferences.emailNewsletter').defaultValue, true);
  assert.equal(User.schema.path('notificationPreferences.emailUnreadSummary').defaultValue, true);
});

test('newsletter selection returns 10 personalized, five trending, and five community posts without repeats', () => {
  const now = Date.now();
  const createdAt = new Date(now - 24 * 60 * 60 * 1000);
  const personalized = Array.from({ length: 10 }, (_, index) => ({
    _id: `personalized-${index}`, author: { _id: `author-${index}`, name: 'Member' }, createdAt,
    hashtags: ['makers'], likes: []
  }));
  const trending = Array.from({ length: 5 }, (_, index) => ({
    _id: `trending-${index}`, author: { _id: `trending-author-${index}` }, createdAt,
    hashtags: [], likes: Array(20 - index).fill('reader')
  }));
  const communityPosts = Array.from({ length: 5 }, (_, index) => ({
    _id: `community-${index}`, author: { _id: `community-author-${index}` }, createdAt,
    community: { _id: `joined-${index}`, name: 'A community', isPrivate: index === 0 },
    hashtags: [], likes: []
  }));
  const posts = [
    ...personalized,
    ...trending,
    ...communityPosts,
    { _id: 'already-sent', author: { _id: 'writer' }, createdAt, hashtags: ['makers'], likes: [] },
    { _id: 'private', author: { _id: 'writer' }, community: { _id: 'private-community', isPrivate: true }, createdAt, hashtags: ['makers'], likes: [1] }
  ];
  const user = {
    _id: 'reader',
    newsletterSentPosts: ['already-sent'],
    joinedCommunities: ['joined-0', 'joined-1', 'joined-2', 'joined-3', 'joined-4']
  };

  const result = buildNewsletterSelection(posts, user, new Map([['makers', 1]]), now);

  assert.equal(result.personalizedPosts.length, 10);
  assert.equal(result.trendingPosts.length, 5);
  assert.equal(result.communityPosts.length, 5);
  const selectedIds = [...result.personalizedPosts, ...result.trendingPosts, ...result.communityPosts].map((post) => String(post._id));
  assert.equal(new Set(selectedIds).size, 20);
  assert.ok(!selectedIds.includes('already-sent'));
  assert.ok(!selectedIds.includes('private'));
  assert.ok(result.personalizedPosts.every((post) => post.hashtags.includes('makers')));
  assert.ok(result.trendingPosts.every((post) => post._id.startsWith('trending-')));
  assert.ok(result.communityPosts.every((post) => post.community));
});