// Community-targeted advertising: target validation, reviewer/advertiser visibility,
// community-page entry point, and the Moderator console menu link.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { icon } = require('../src/utils/icons');
const { preview } = require('../src/utils/textPreview');
const Advertiser = require('../src/models/Advertiser');
const Campaign = require('../src/models/Campaign');
const Community = require('../src/models/Community');
const { createCampaign, COMMUNITY_AD_ELIGIBLE_FILTER } = require('../src/services/advertising');

const views = path.join(__dirname, '..', 'src', 'views');
const user = (role = 'user') => ({ id: 'u1', name: 'Puneet K', email: 'p@x.com', role, profilePicture: '' });
const render = (file, data = {}) => ejs.renderFile(path.join(views, file), {
  icon, preview, csrfToken: 'tok', flash: null, currentUser: user(), appUrl: 'http://x', ...data
});
const OID_A = '64b7f0f0f0f0f0f0f0f0f0a1';
const OID_B = '64b7f0f0f0f0f0f0f0f0f0b2';
const lean = (rows) => ({ select() { return this; }, lean: async () => rows });
const baseInput = (extra = {}) => ({
  advertiserId: 'adv', title: 'Launch', campaignType: 'service', advertisingRightsConfirmed: true,
  totalBudget: 50, destinationUrl: 'https://example.test/', ...extra
});
function mockAdvertiser(t) {
  t.mock.method(Advertiser, 'findById', async () => ({
    _id: 'adv', status: 'approved', termsVersion: '2026-10-07-v3', termsAcceptedAt: new Date()
  }));
  return t.mock.method(Campaign, 'create', async (data) => ({ ...data, _id: 'campaign-1' }));
}

test('eligibility filter requires a public, approved, ad-enabled community that has not disabled placement', () => {
  assert.equal(COMMUNITY_AD_ELIGIBLE_FILTER.isPrivate, false);
  assert.equal(COMMUNITY_AD_ELIGIBLE_FILTER.isMonetized, true);
  assert.equal(COMMUNITY_AD_ELIGIBLE_FILTER.monetizationStatus, 'approved');
  assert.equal(COMMUNITY_AD_ELIGIBLE_FILTER['monetizationSettings.adsEnabled'], true);
  assert.deepEqual(COMMUNITY_AD_ELIGIBLE_FILTER['monetizationSettings.adPlacement'], { $ne: 'none' });
});

test('createCampaign stores only validated, de-duplicated target communities', async (t) => {
  const create = mockAdvertiser(t);
  const find = t.mock.method(Community, 'find', (query) => {
    assert.deepEqual(query._id.$in, [OID_A, OID_B]);
    assert.equal(query.isPrivate, false);
    return lean([{ _id: OID_A }, { _id: OID_B }]);
  });
  const campaign = await createCampaign(baseInput({ targetCommunities: [OID_A, OID_B, OID_A] }));
  assert.deepEqual(campaign.targetCommunities, [OID_A, OID_B]);
  assert.equal(find.mock.callCount(), 1);
  assert.equal(create.mock.callCount(), 1);
});

test('createCampaign rejects communities that are private, unmonetized or ad-disabled', async (t) => {
  const create = mockAdvertiser(t);
  t.mock.method(Community, 'find', () => lean([{ _id: OID_A }]));
  await assert.rejects(
    () => createCampaign(baseInput({ targetCommunities: [OID_A, OID_B] })),
    /public communities that currently accept approved ads/
  );
  assert.equal(create.mock.callCount(), 0, 'no campaign may be created for an ineligible target');
});

test('createCampaign rejects malformed community ids without querying the database', async (t) => {
  mockAdvertiser(t);
  const find = t.mock.method(Community, 'find', () => lean([]));
  await assert.rejects(() => createCampaign(baseInput({ targetCommunities: ['not-an-id'] })), /public communities/);
  assert.equal(find.mock.callCount(), 0);
});

test('createCampaign refuses to combine community targets with the sitewide fallback', async (t) => {
  mockAdvertiser(t);
  t.mock.method(Community, 'find', () => lean([{ _id: OID_A }]));
  await assert.rejects(
    () => createCampaign(baseInput({ targetCommunities: [OID_A], sitewideFallback: true })),
    /either specific communities or the Crowdwide-feed fallback/
  );
});

test('campaigns without targets skip the community lookup entirely', async (t) => {
  mockAdvertiser(t);
  const find = t.mock.method(Community, 'find', () => lean([]));
  const campaign = await createCampaign(baseInput({ sitewideFallback: true }));
  assert.deepEqual(campaign.targetCommunities, []);
  assert.equal(find.mock.callCount(), 0);
});

test('campaign-targets partial names communities and tolerates unpopulated ids', async () => {
  const named = await render('partials/campaign-targets.ejs', {
    campaign: { targetCommunities: [{ _id: 'c1', name: 'Design Lab', slug: 'design-lab' }, { _id: 'c2', name: '<b>Evil</b>' }] }
  });
  assert.match(named, /2 communities/);
  assert.match(named, /<a href="\/communities\/design-lab">Design Lab<\/a>/);
  assert.match(named, /&lt;b&gt;Evil&lt;\/b&gt;/, 'names are escaped');
  const raw = await render('partials/campaign-targets.ejs', { campaign: { targetCommunities: ['c1'] } });
  assert.match(raw.trim(), /^1 community$/);
});

test('advertiser dashboard shows the Sponsored target communities and preselects the linked one', async () => {
  const data = {
    title: 'Advertising dashboard', pagePath: '/advertising', noIndex: true,
    advertiser: { _id: 'a1', businessName: 'Example Co', status: 'approved', user: 'u1' },
    campaigns: [{
      _id: 'k1', title: 'Targeted', status: 'active', fundingStatus: 'funded', campaignType: 'service',
      targetCommunities: [{ _id: 'c1', name: 'Design Lab', slug: 'design-lab' }], sitewideFallback: false,
      moderationHistory: []
    }],
    communities: [{ _id: 'c1', name: 'Design Lab', slug: 'design-lab' }, { _id: 'c2', name: 'Other', slug: 'other' }],
    preselectedCommunityId: 'c2',
    advertisingTermsVersion: '2026-10-07-v3', advertisingTermsAccepted: true,
    totals: { impressions: 0, clicks: 0, ctr: 0, wavesSpent: 0, remainingBudget: 0 }
  };
  const html = await render('pages/advertising-dashboard.ejs', data);
  assert.match(html, /Sponsored in .*Design Lab.* only\. It is never shown anywhere else/s);
  assert.match(html, /value="c2" checked/);
  assert.doesNotMatch(html, /value="c1" checked/);
  assert.match(html, /id="submit-ad"/);
});

test('moderator and admin review screens show which communities an ad targets', async () => {
  const targets = [{ _id: 'c1', name: 'Design Lab', slug: 'design-lab' }];
  const moderator = await render('pages/moderator.ejs', {
    title: 'Moderator console', pagePath: '/moderator', noIndex: true,
    moderator: { moderatorId: 'MOD-1' }, reviewThreshold: 2, reportedOnly: false,
    reports: [], actions: [], communities: [], moderationFeed: [], pendingAppeals: [], pendingAdvertisers: [],
    pendingCampaigns: [{
      _id: 'k1', title: 'Targeted', description: 'Text', totalBudget: 100, targetCommunities: targets,
      advertiser: { businessName: 'Example Co', user: { name: 'Asha' } }, moderationHistory: []
    }],
    myOpenReportRecommendations: new Set()
  });
  assert.match(moderator, /targets: .*Design Lab/s);
  assert.match(moderator, /labelled Sponsored/);
});

test('community page offers "Advertise here" only when the community accepts ads', async () => {
  const community = { _id: 'c1', slug: 'design-lab', name: 'Design Lab', category: 'design', description: 'Share ideas', hashtags: [], membersCount: 1, isPrivate: false, owner: { _id: 'u9', name: 'Owner' }, members: ['u1'], moderators: [], pinnedPosts: [] };
  const page = (extra) => render('pages/community-detail.ejs', {
    title: 'Design Lab', pagePath: '/communities/design-lab', noIndex: true, community,
    posts: [], members: [], moderatorIds: [], joined: true, requested: false, isOwner: false, locked: false, quests: [], ...extra
  });
  const open = await page({ acceptsAds: true });
  assert.match(open, /href="\/advertising\?community=design-lab#submit-ad"/);
  assert.doesNotMatch(await page({ acceptsAds: false }), /Advertise in this community/);
  assert.doesNotMatch(await page({}), /Advertise in this community/);
});

test('Moderator console menu link is shown to moderators and admins only', async () => {
  const nav = (role) => render('partials/app-nav.ejs', { currentUser: user(role), active: '' });
  for (const role of ['moderator', 'admin']) {
    const html = await nav(role);
    assert.equal((html.match(/href="\/moderator"/g) || []).length, 2, `${role}: desktop menu and mobile drawer`);
  }
  assert.match(await nav('admin'), /href="\/admin"/);
  assert.doesNotMatch(await nav('moderator'), /href="\/admin"/);
  assert.doesNotMatch(await nav('user'), /href="\/moderator"/);
  const marketing = (role) => render('partials/nav.ejs', { currentUser: user(role) });
  assert.match(await marketing('moderator'), /href="\/moderator"/);
  assert.doesNotMatch(await marketing('user'), /href="\/moderator"/);
});
