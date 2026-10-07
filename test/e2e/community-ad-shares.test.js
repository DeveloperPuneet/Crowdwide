const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { startTestDatabase, stopTestDatabase, extractCsrfToken, createAgent } = require('./helpers');

let dbHandle;
let app;
let User;
let Community;
let Advertiser;
let Campaign;
let CampaignEvent;
let WavesLedgerEntry;
const request = require('supertest');

test.before(async () => {
  dbHandle = await startTestDatabase();
  app = require('../../src/app')({ port: 3000 });
  User = require('../../src/models/User');
  Community = require('../../src/models/Community');
  Advertiser = require('../../src/models/Advertiser');
  Campaign = require('../../src/models/Campaign');
  CampaignEvent = require('../../src/models/CampaignEvent');
  WavesLedgerEntry = require('../../src/models/WavesLedgerEntry');
});

test.after(async () => {
  await stopTestDatabase(dbHandle, app);
});

async function loginAs(agent, email, password) {
  const loginPage = await agent.get('/auth/login');
  const response = await agent.post('/auth/login', {
    _csrf: extractCsrfToken(loginPage.text),
    email,
    password
  });
  assert.equal(response.status, 302, `login should succeed for ${email}`);
  return response;
}

function postWithCsrfHeader(agent, path, token, fields) {
  return request(app)
    .post(path)
    .set('Cookie', agent.getCookie())
    .set('X-CSRF-Token', token)
    .type('form')
    .send(fields);
}

test('eligible community campaign spend credits its owner once and appears in owner and wallet history', async () => {
  const suffix = Date.now();
  const password = 'a-strong-password-123';
  const owner = await User.create({
    name: 'Waves Community Owner',
    email: `community-waves-owner.${suffix}@example.com`,
    password: await bcrypt.hash(password, 12),
    isVerified: true
  });
  const viewer = await User.create({
    name: 'Ad Viewer',
    email: `community-waves-viewer.${suffix}@example.com`,
    password: await bcrypt.hash(password, 12),
    isVerified: true
  });
  const advertiserUser = await User.create({
    name: 'Advertiser',
    email: `community-waves-advertiser.${suffix}@example.com`,
    password: await bcrypt.hash(password, 12),
    isVerified: true
  });
  const community = await Community.create({
    owner: owner._id,
    name: `Waves Share Community ${suffix}`,
    slug: `waves-share-community-${suffix}`,
    description: 'Eligible community campaign tests.',
    isPrivate: false,
    members: [owner._id, viewer._id],
    membersCount: 2,
    monetizationStatus: 'approved',
    isMonetized: true,
    monetizationSettings: {
      adsEnabled: true,
      adPlacement: 'feed',
      adFrequency: 1,
      revenueSharePercent: 60
    }
  });
  const advertiser = await Advertiser.create({
    user: advertiserUser._id,
    businessName: 'Test Advertiser',
    status: 'approved'
  });
  const campaign = await Campaign.create({
    advertiser: advertiser._id,
    title: 'Community Waves campaign',
    status: 'active',
    fundingStatus: 'funded',
    totalBudget: 5,
    remainingBudget: 5,
    impressionCostWaves: 0.25,
    clickCostWaves: 1,
    dailyBudget: 5,
    targetCommunities: [community._id],
    destinationUrl: 'https://example.test/offer'
  });

  const viewerAgent = createAgent(app);
  await loginAs(viewerAgent, viewer.email, password);
  const viewerCommunityPage = await viewerAgent.get(`/communities/${community.slug}`);
  assert.equal(viewerCommunityPage.status, 200);
  const eventToken = '12345678-1234-4123-8123-123456789abc';
  const viewerCsrfToken = extractCsrfToken(viewerCommunityPage.text);
  const impression = await postWithCsrfHeader(viewerAgent, `/ads/${campaign._id}/impression`, viewerCsrfToken, {
    communityId: String(community._id),
    eventToken
  });
  assert.equal(impression.status, 204, `viewer ad impression should be accepted: ${impression.text}`);
  assert.equal(Number((await User.findById(owner._id)).wavesBalance), 0.15);

  const duplicateCommunityPage = await viewerAgent.get(`/communities/${community.slug}`);
  const duplicateImpression = await postWithCsrfHeader(viewerAgent, `/ads/${campaign._id}/impression`, extractCsrfToken(duplicateCommunityPage.text), {
    communityId: String(community._id),
    eventToken: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  });
  assert.equal(duplicateImpression.status, 204);

  const unauthenticated = await request(app).post(`/ads/${campaign._id}/impression`).type('form').send({
    communityId: String(community._id),
    eventToken: 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa'
  });
  assert.equal(unauthenticated.status, 403);

  const ownerAgent = createAgent(app);
  await loginAs(ownerAgent, owner.email, password);
  const ownerCommunityPage = await ownerAgent.get(`/communities/${community.slug}`);
  assert.equal(ownerCommunityPage.status, 200);
  const ownerSelfImpression = await postWithCsrfHeader(ownerAgent, `/ads/${campaign._id}/impression`, extractCsrfToken(ownerCommunityPage.text), {
    communityId: String(community._id),
    eventToken: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
  });
  assert.equal(ownerSelfImpression.status, 204);
  assert.equal(await CampaignEvent.countDocuments({ campaign: campaign._id }), 2);
  assert.equal(await WavesLedgerEntry.countDocuments({ user: owner._id, referenceType: 'community-ad-share', status: 'posted' }), 1);
  assert.equal(Number((await User.findById(owner._id)).wavesBalance), 0.15);

  const managePage = await ownerAgent.get(`/communities/${community._id}/manage`);
  assert.equal(managePage.status, 200);
  assert.match(managePage.text, /Owner share/);
  assert.match(managePage.text, /Recent Waves earnings/);
  assert.match(managePage.text, /\+0\.15 Waves/);

  const walletPage = await ownerAgent.get('/wallet');
  assert.equal(walletPage.status, 200);
  assert.match(walletPage.text, /Community ad share/);
  assert.match(walletPage.text, new RegExp(community.name));
});
