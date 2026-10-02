const test = require('node:test');
const assert = require('node:assert/strict');
const { NEWSLETTER_CRON, buildNewsletterSelection } = require('../src/services/newsletterWorker');
const User = require('../src/models/User');

test('newsletter delivery is scheduled Sunday at 10:30 and email options default on', () => {
  assert.equal(NEWSLETTER_CRON, '30 10 * * 0');
  assert.equal(User.schema.path('notificationPreferences.emailNewsletter').defaultValue, true);
  assert.equal(User.schema.path('notificationPreferences.emailUnreadSummary').defaultValue, true);
});

test('newsletter selection returns five engaged and seven interest posts without repeats or private posts', () => {
  const now = Date.now();
  const createdAt = new Date(now - 24 * 60 * 60 * 1000);
  const engaged = Array.from({ length: 5 }, (_, index) => ({
    _id: `engaged-${index}`, author: { _id: `author-${index}`, name: 'Member' }, createdAt,
    hashtags: [], likes: Array(10 - index).fill('reader'), commentsCount: 0
  }));
  const interest = Array.from({ length: 8 }, (_, index) => ({
    _id: `interest-${index}`, author: { _id: `maker-${index}`, name: 'Maker' }, createdAt,
    hashtags: ['makers'], likes: []
  }));
  const posts = [
    ...engaged,
    ...interest,
    { _id: 'already-sent', author: { _id: 'writer' }, createdAt, hashtags: ['makers'], likes: [] },
    { _id: 'private', author: { _id: 'writer' }, community: { _id: 'private-community', isPrivate: true }, createdAt, hashtags: ['makers'], likes: [1] }
  ];
  const user = { _id: 'reader', newsletterSentPosts: ['already-sent'], joinedCommunities: [] };

  const result = buildNewsletterSelection(posts, user, new Map([['makers', 1]]), now);

  assert.equal(result.engagedPosts.length, 5);
  assert.equal(result.interestPosts.length, 7);
  const selectedIds = [...result.engagedPosts, ...result.interestPosts].map((post) => String(post._id));
  assert.equal(new Set(selectedIds).size, 12);
  assert.ok(!selectedIds.includes('already-sent'));
  assert.ok(!selectedIds.includes('private'));
  assert.ok(result.interestPosts.every((post) => post.hashtags.includes('makers')));
});