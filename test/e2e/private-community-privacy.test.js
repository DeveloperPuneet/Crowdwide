const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { startTestDatabase, stopTestDatabase, extractCsrfToken, createAgent } = require('./helpers');

let dbHandle;
let app;
let User;
let Community;
let Post;

test.before(async () => {
  dbHandle = await startTestDatabase();
  const createApp = require('../../src/app');
  app = createApp({ port: 3000 });
  User = require('../../src/models/User');
  Community = require('../../src/models/Community');
  Post = require('../../src/models/Post');
});

test.after(async () => {
  await stopTestDatabase(dbHandle);
});

async function loginAs(agent, email, password) {
  const loginPage = await agent.get('/auth/login');
  const loginToken = extractCsrfToken(loginPage.text);
  return agent.post('/auth/login', { _csrf: loginToken, email, password });
}

test('a private community\'s posts are invisible to a non-member everywhere they were previously leaking', async () => {
  const memberEmail = `private-member.${Date.now()}@example.com`;
  const outsiderEmail = `private-outsider.${Date.now()}@example.com`;
  const password = 'a-strong-password-123';

  const member = await User.create({ name: 'Community Member', email: memberEmail, password: await bcrypt.hash(password, 12), isVerified: true });
  await User.create({ name: 'Outsider', email: outsiderEmail, password: await bcrypt.hash(password, 12), isVerified: true });

  const secretPhrase = `top-secret-content-${Date.now()}`;
  const community = await Community.create({
    owner: member._id,
    name: 'Secret Club',
    slug: `secret-club-${Date.now()}`,
    isPrivate: true,
    members: [member._id],
    memberRoles: [{ user: member._id, role: 'member' }],
    membersCount: 1
  });
  const post = await Post.create({ author: member._id, body: secretPhrase, type: 'post', status: 'published', community: community._id });

  const outsiderAgent = createAgent(app);
  await loginAs(outsiderAgent, outsiderEmail, password);

  // 1. The community page itself must not show the post or member list.
  const communityPage = await outsiderAgent.get(`/communities/${community.slug}`);
  assert.equal(communityPage.status, 200);
  assert.doesNotMatch(communityPage.text, new RegExp(secretPhrase));
  assert.match(communityPage.text, /private community/i);

  // 2. The direct post URL must 404, not show the content.
  const postPage = await outsiderAgent.get(`/posts/${post._id}`);
  assert.equal(postPage.status, 404);
  assert.doesNotMatch(postPage.text, new RegExp(secretPhrase));

  // 3. The main dashboard feed must not surface it.
  const dashboard = await outsiderAgent.get('/dashboard');
  assert.equal(dashboard.status, 200);
  assert.doesNotMatch(dashboard.text, new RegExp(secretPhrase));
  const dashboardNewTab = await outsiderAgent.get('/dashboard?view=posts-new');
  assert.doesNotMatch(dashboardNewTab.text, new RegExp(secretPhrase));

  // 4. Search must not surface it.
  const searchResults = await outsiderAgent.get(`/search?q=${encodeURIComponent(secretPhrase)}`);
  assert.equal(searchResults.status, 200);
  assert.doesNotMatch(searchResults.text, new RegExp(secretPhrase));

  // 5. The public JSON API (no auth at all) must not return it, even when
  // asked for that exact community's posts by ID.
  const request = require('supertest');
  const apiResponse = await request(app).get(`/api/v1/posts?community=${community._id}`);
  assert.equal(apiResponse.status, 200);
  assert.equal(apiResponse.body.data.length, 0);
  const apiResponseUnfiltered = await request(app).get('/api/v1/posts?limit=50');
  assert.ok(!apiResponseUnfiltered.body.data.some((item) => item.body === secretPhrase));

  // 6. Neither the global RSS feed nor the community's own RSS route
  // (which should 404 for a private community) expose it.
  const globalRss = await request(app).get('/rss.xml');
  assert.doesNotMatch(globalRss.text, new RegExp(secretPhrase));
  const communityRssResponse = await request(app).get(`/communities/${community.slug}/rss.xml`);
  assert.equal(communityRssResponse.status, 404);

  // 7. Interaction endpoints must also refuse - liking a post you can't
  // see must not succeed either.
  const likeToken = extractCsrfToken(dashboard.text);
  const likeAttempt = await outsiderAgent.post(`/posts/${post._id}/like`, { _csrf: likeToken });
  assert.equal(likeAttempt.status, 302);
  const postAfterLikeAttempt = await Post.findById(post._id).select('likes');
  assert.equal(postAfterLikeAttempt.likes.length, 0);

  // Sanity check: the actual member CAN see it, proving this isn't just
  // broken for everyone.
  const memberAgent = createAgent(app);
  await loginAs(memberAgent, memberEmail, password);
  const memberCommunityPage = await memberAgent.get(`/communities/${community.slug}`);
  assert.match(memberCommunityPage.text, new RegExp(secretPhrase));
  const memberPostPage = await memberAgent.get(`/posts/${post._id}`);
  assert.equal(memberPostPage.status, 200);
  assert.match(memberPostPage.text, new RegExp(secretPhrase));
});
