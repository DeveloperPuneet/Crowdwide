const test = require('node:test');
const assert = require('node:assert/strict');

const Advertiser = require('../src/models/Advertiser');
const Appeal = require('../src/models/Appeal');
const AuditLog = require('../src/models/AuditLog');
const Campaign = require('../src/models/Campaign');
const CampaignAbuseSignal = require('../src/models/CampaignAbuseSignal');
const CampaignEvent = require('../src/models/CampaignEvent');
const Community = require('../src/models/Community');
const Report = require('../src/models/Report');
const User = require('../src/models/User');
const WavesLedgerEntry = require('../src/models/WavesLedgerEntry');
const {
  calculateCtr,
  createCampaign,
  getCampaignAnalytics,
  getCommunityCampaigns,
  getSitewideFeedCampaigns,
  fundCampaign,
  refundCampaignBudget,
  recordCampaignPerformance,
  recordCampaignEvent,
  registerAdvertiser,
  reviewAdvertiserAsModerator,
  reviewCampaignAsModerator,
  submitCampaign,
  spendCampaignBudget,
  updateAdvertiserStatus,
  updateCampaignStatus
} = require('../src/services/advertising');
const advertisingController = require('../src/controllers/advertisingController');
const adminController = require('../src/controllers/adminController');

test('advertiser can appeal a rejected account once and the decision reason is preserved', async (t) => {
  const advertiser = {
    _id: 'advertiser-appeal',
    status: 'rejected',
    rejectionReason: 'Business details need verification.',
    moderationHistory: [{ status: 'rejected', reason: 'Business details need verification.' }]
  };
  const created = [];
  t.mock.method(Advertiser, 'findOne', async () => advertiser);
  t.mock.method(Appeal, 'create', async (data) => {
    created.push(data);
    return data;
  });
  const req = {
    session: { user: { id: 'user-appeal' } },
    body: { message: 'Please reconsider; I provided the requested business details.' }
  };
  const res = { redirect(path) { this.path = path; } };

  await advertisingController.submitAdvertiserAppeal(req, res);
  assert.equal(res.path, '/advertising');
  assert.equal(created.length, 1);
  assert.equal(created[0].user, 'user-appeal');
  assert.equal(created[0].advertiser, 'advertiser-appeal');
  assert.equal(created[0].actionType, 'advertiser');
  assert.equal(created[0].reasonSnapshot, 'Business details need verification.');
  assert.equal(created[0].message, req.body.message);
  assert.equal(req.session.flash.type, 'success');
});

test('advertiser appeal form rejects accounts that are neither rejected nor suspended', async (t) => {
  t.mock.method(Advertiser, 'findOne', async () => ({ _id: 'a1', status: 'approved' }));
  const req = {
    session: { user: { id: 'user-appeal' } },
    body: { message: 'I want to appeal.' }
  };
  const res = { redirect(path) { this.path = path; } };

  await advertisingController.submitAdvertiserAppeal(req, res);
  assert.equal(res.path, '/advertising');
  assert.equal(req.session.flash.type, 'error');
});

test('duplicate pending advertiser appeal is reported without creating another record', async (t) => {
  const advertiser = { _id: 'advertiser-appeal', status: 'suspended', moderationHistory: [] };
  t.mock.method(Advertiser, 'findOne', async () => advertiser);
  t.mock.method(Appeal, 'create', async () => {
    const error = new Error('Duplicate advertiser appeal.');
    error.code = 11000;
    throw error;
  });
  const req = {
    session: { user: { id: 'user-appeal' } },
    body: { message: 'Please review the suspension.' }
  };
  const res = { redirect(path) { this.path = path; } };

  await advertisingController.submitAdvertiserAppeal(req, res);
  assert.equal(res.path, '/advertising');
  assert.equal(req.session.flash.type, 'error');
  assert.match(req.session.flash.message, /already have a pending/i);
});

test('admin approval of advertiser appeal restores the account and records appeal audit history', async (t) => {
  const appeal = {
    _id: 'appeal-advertiser-1',
    user: 'user-appeal',
    advertiser: 'advertiser-appeal',
    actionType: 'advertiser',
    status: 'pending',
    reasonSnapshot: 'Business verification issue.',
    message: 'Verification has now been supplied.',
    async save() {
      return this;
    }
  };
  const advertiser = {
    _id: 'advertiser-appeal',
    user: 'user-appeal',
    status: 'suspended',
    isVerified: true,
    moderationHistory: [{ status: 'suspended', reason: 'Business verification issue.' }],
    async save() {
      return this;
    }
  };
  const audits = [];
  t.mock.method(Appeal, 'findById', async () => appeal);
  t.mock.method(Advertiser, 'findOne', async () => advertiser);
  t.mock.method(AuditLog, 'create', async (data) => {
    audits.push(data);
    return data;
  });
  const req = {
    params: { id: appeal._id },
    body: { decision: 'approve', note: 'Documents verified.' },
    roleUser: { _id: 'admin-1', role: 'admin' },
    session: { flash: null },
    ip: '127.0.0.1',
    get() { return 'test-agent'; }
  };
  const res = { redirect(path) { this.path = path; } };

  await adminController.resolveAppeal(req, res);
  assert.equal(res.path, '/admin#appeals');
  assert.equal(appeal.status, 'approved');
  assert.equal(appeal.reviewNote, 'Documents verified.');
  assert.equal(advertiser.status, 'approved');
  assert.equal(advertiser.rejectionReason, '');
  assert.equal(advertiser.moderationHistory.at(-1).reason, 'Documents verified.');
  assert.equal(audits[0].action, 'approve-appeal');
  assert.equal(audits[0].targetType, 'advertiser');
});

test('registerAdvertiser creates an advertiser profile for a user', async (t) => {
  const originalFindOneAndUpdate = Advertiser.findOneAndUpdate;
  const stub = t.mock.method(Advertiser, 'findOneAndUpdate', async (query, update) => ({
    _id: 'advertiser-1',
    user: query.user,
    businessName: update.businessName,
    businessDescription: update.businessDescription,
    website: update.website,
    logoUrl: update.logoUrl,
    bannerUrl: update.bannerUrl,
    notes: update.notes,
    isVerified: update.isVerified,
    status: update.status,
    termsAcceptedAt: update.termsAcceptedAt,
    termsVersion: update.termsVersion
  }));

  const advertiser = await registerAdvertiser({
    userId: 'user-1',
    businessName: 'Crowdwide Ads',
    businessDescription: 'A creative studio offering commissioned artwork.',
    website: 'https://example.com',
    logoUrl: 'https://cdn.example.test/logo.png',
    bannerUrl: 'https://cdn.example.test/banner.png',
    notes: 'Launch campaign soon',
    isVerified: true,
    acceptedTerms: true
  });

  assert.equal(advertiser.businessName, 'Crowdwide Ads');
  assert.equal(advertiser.businessDescription, 'A creative studio offering commissioned artwork.');
  assert.equal(advertiser.logoUrl, 'https://cdn.example.test/logo.png');
  assert.equal(advertiser.bannerUrl, 'https://cdn.example.test/banner.png');
  assert.equal(advertiser.status, 'pending');
  assert.equal(advertiser.termsVersion, '2026-10-07-v2');
  assert.ok(advertiser.termsAcceptedAt instanceof Date);
  assert.equal(stub.mock.callCount(), 1);

  Advertiser.findOneAndUpdate = originalFindOneAndUpdate;
});

test('createCampaign rejects unapproved advertisers and enforces daily budget limits', async (t) => {
  t.mock.method(Advertiser, 'findById', async (id) => {
    if (String(id) === 'advertiser-1') {
      return { _id: 'advertiser-1', status: 'pending' };
    }
    return { _id: 'advertiser-2', status: 'approved', termsVersion: '2026-10-07-v2', termsAcceptedAt: new Date() };
  });

  await assert.rejects(() => createCampaign({
    advertiserId: 'advertiser-1',
    title: 'Launch campaign',
    totalBudget: 100,
    dailyBudget: 120
  }), /approved advertisers/i);

  const createCampaignEntry = t.mock.method(Campaign, 'create', async (data) => ({ ...data, _id: 'campaign-1' }));

  const campaign = await createCampaign({
    advertiserId: 'advertiser-2',
    title: 'Launch campaign',
    campaignType: 'product',
    productName: 'Crowdwide Mug',
    productPrice: '$19.99',
    advertisingRightsConfirmed: true,
    totalBudget: 100,
    dailyBudget: 40,
    destinationUrl: 'https://example.test/product',
    bannerUrl: '/media/banner-1',
    impressionCostWaves: 0.25,
    clickCostWaves: 1.5,
    startDate: '2026-01-01',
    endDate: '2026-01-05',
    status: 'draft'
  });

  assert.equal(campaign.status, 'draft');
  assert.equal(campaign.campaignType, 'product');
  assert.equal(campaign.productName, 'Crowdwide Mug');
  assert.equal(campaign.productPrice, '$19.99');
  assert.ok(campaign.rightsConfirmedAt instanceof Date);
  assert.equal(campaign.remainingBudget, 0);
  assert.equal(campaign.destinationUrl, 'https://example.test/product');
  assert.equal(campaign.bannerUrl, '/media/banner-1');
  assert.equal(campaign.impressionCostWaves, 0.25);
  assert.equal(campaign.clickCostWaves, 1.5);
  assert.equal(createCampaignEntry.mock.callCount(), 1);
});

test('campaign creation rejects budgets below the configured minimum and unsafe destination schemes', async (t) => {
  t.mock.method(Advertiser, 'findById', async () => ({
    _id: 'advertiser-2', status: 'approved', termsVersion: '2026-10-07-v2', termsAcceptedAt: new Date()
  }));
  await assert.rejects(() => createCampaign({
    advertiserId: 'advertiser-2', title: 'Too small', totalBudget: 10,
    minimumBudget: 25, advertisingRightsConfirmed: true
  }), /at least 25 Waves/);
  await assert.rejects(() => createCampaign({
    advertiserId: 'advertiser-2', title: 'Unsafe link', totalBudget: 50,
    destinationUrl: 'javascript:alert(1)', advertisingRightsConfirmed: true
  }), /valid http or https destination link/);
  await assert.rejects(() => createCampaign({
    advertiserId: 'advertiser-2', title: 'Missing rights confirmation', totalBudget: 50
  }), /own or are authorized to advertise/i);
  await assert.rejects(() => createCampaign({
    advertiserId: 'advertiser-2', title: 'Invalid campaign type', totalBudget: 50,
    campaignType: 'unsupported', advertisingRightsConfirmed: true
  }), /valid advertisement type/i);
  await assert.rejects(() => createCampaign({
    advertiserId: 'advertiser-2', title: 'Unnamed product', totalBudget: 50,
    campaignType: 'product', advertisingRightsConfirmed: true
  }), /product you are advertising/i);
});

test('submitting a campaign escrows its budget and records a deduplicated Waves ledger entry', async (t) => {
  const campaign = {
    _id: 'campaign-funded',
    advertiser: 'advertiser-funded',
    title: 'Launch campaign',
    status: 'draft',
    isWavesFunded: true,
    fundingStatus: 'unfunded',
    totalBudget: 40,
    remainingBudget: 0,
    moderationHistory: [],
    async save() {
      return this;
    }
  };
  const ledgerEntry = {
    user: 'owner-1',
    amount: -40,
    status: 'pending',
    async save() {
      return this;
    }
  };
  t.mock.method(Campaign, 'findById', async () => campaign);
  t.mock.method(Advertiser, 'findById', async () => ({ user: 'owner-1', status: 'approved', termsVersion: '2026-10-07-v2', termsAcceptedAt: new Date() }));
  t.mock.method(WavesLedgerEntry, 'create', async (entry) => Object.assign(ledgerEntry, entry));
  t.mock.method(User, 'updateOne', async () => ({ modifiedCount: 1 }));
  t.mock.method(User, 'findById', () => ({
    select() {
      return this;
    },
    lean: async () => ({ wavesBalance: 60 })
  }));

  const submitted = await submitCampaign({ campaignId: campaign._id });
  const retriedSubmission = await submitCampaign({ campaignId: campaign._id });

  assert.equal(submitted.status, 'submitted');
  assert.equal(retriedSubmission, campaign);
  assert.equal(submitted.fundingStatus, 'funded');
  assert.equal(submitted.remainingBudget, 40);
  assert.equal(ledgerEntry.type, 'campaign');
  assert.equal(ledgerEntry.amount, -40);
  assert.equal(ledgerEntry.status, 'posted');
  assert.equal(ledgerEntry.rewardKey, 'campaign-fund:campaign-funded');
});

test('campaign budget submission fails cleanly when wallet balance is insufficient', async (t) => {
  const campaign = {
    _id: 'campaign-poor',
    advertiser: 'advertiser-poor',
    title: 'Launch campaign',
    status: 'draft',
    isWavesFunded: true,
    fundingStatus: 'unfunded',
    totalBudget: 40,
    remainingBudget: 0
  };
  const ledgerEntry = {
    status: 'pending',
    async save() {
      return this;
    }
  };
  t.mock.method(Campaign, 'findById', async () => campaign);
  t.mock.method(Advertiser, 'findById', async () => ({ user: 'owner-poor', status: 'approved', termsVersion: '2026-10-07-v2', termsAcceptedAt: new Date() }));
  t.mock.method(WavesLedgerEntry, 'create', async (entry) => Object.assign(ledgerEntry, entry));
  t.mock.method(User, 'updateOne', async () => ({ modifiedCount: 0 }));

  await assert.rejects(() => submitCampaign({ campaignId: campaign._id }), /insufficient Waves balance/i);
  assert.equal(ledgerEntry.status, 'reversed');
  assert.equal(campaign.fundingStatus, 'unfunded');
});

test('cancelling a funded campaign refunds only its remaining Waves budget once', async (t) => {
  const campaign = {
    _id: 'campaign-refund',
    advertiser: 'advertiser-refund',
    title: 'Cancelled campaign',
    status: 'active',
    isWavesFunded: true,
    fundingStatus: 'funded',
    fundingUser: 'owner-refund',
    totalBudget: 50,
    remainingBudget: 30,
    refundedBudget: 0,
    wavesSpent: 20,
    moderationHistory: [],
    async save() {
      return this;
    }
  };
  const ledgerEntry = {
    status: 'pending',
    async save() {
      return this;
    }
  };
  t.mock.method(Campaign, 'findById', async () => campaign);
  t.mock.method(WavesLedgerEntry, 'create', async (entry) => Object.assign(ledgerEntry, entry));
  t.mock.method(User, 'updateOne', async () => ({ modifiedCount: 1 }));
  t.mock.method(User, 'findById', () => ({
    select() {
      return this;
    },
    lean: async () => ({ wavesBalance: 80 })
  }));

  const updated = await updateCampaignStatus({
    campaignId: campaign._id,
    status: 'cancelled',
    actorId: 'admin-1'
  });

  assert.equal(updated.status, 'cancelled');
  assert.equal(updated.remainingBudget, 0);
  assert.equal(updated.refundedBudget, 30);
  assert.equal(updated.fundingStatus, 'refunded');
  assert.equal(ledgerEntry.type, 'refund');
  assert.equal(ledgerEntry.amount, 30);
  assert.equal(ledgerEntry.rewardKey, 'campaign-refund:campaign-refund');

  const noSecondRefund = await refundCampaignBudget({ campaignId: campaign._id });
  assert.equal(noSecondRefund.refundedBudget, 30);
});

test('spendCampaignBudget enforces daily spend limits and resets the counter on a new day', async (t) => {
  const today = new Date();
  const campaign = {
    _id: 'campaign-daily',
    status: 'active',
    fundingStatus: 'funded',
    dailyBudget: 10,
    dailyBudgetSpent: 8,
    dailyBudgetDate: new Date(today.getFullYear(), today.getMonth(), today.getDate()),
    remainingBudget: 40,
    wavesSpent: 10,
    async save() {
      return this;
    }
  };
  t.mock.method(Campaign, 'findById', async () => campaign);

  await assert.rejects(() => spendCampaignBudget({ campaignId: campaign._id, amount: 3 }), /daily budget/i);
  const spent = await spendCampaignBudget({ campaignId: campaign._id, amount: 2 });
  assert.equal(spent.dailyBudgetSpent, 10);
  assert.equal(spent.remainingBudget, 38);
  assert.equal(spent.wavesSpent, 12);

  campaign.dailyBudgetDate = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const resetSpend = await spendCampaignBudget({ campaignId: campaign._id, amount: 4 });
  assert.equal(resetSpend.dailyBudgetSpent, 4);
});

test('recordCampaignPerformance calculates CTR and preserves totals', async (t) => {
  const campaign = {
    _id: 'campaign-1',
    impressions: 0,
    clicks: 0,
    ctr: 0,
    async save() {
      return this;
    }
  };

  t.mock.method(Campaign, 'findById', async () => campaign);

  const updated = await recordCampaignPerformance({
    campaignId: 'campaign-1',
    impressions: 200,
    clicks: 15
  });

  assert.equal(updated.impressions, 200);
  assert.equal(updated.clicks, 15);
  assert.equal(updated.ctr, 7.5);
  assert.equal(calculateCtr({ impressions: 200, clicks: 15 }), 7.5);
});

test('community ad delivery only returns live funded campaigns for eligible public communities', async (t) => {
  const community = {
    _id: 'community-1', isPrivate: false, isMonetized: true, monetizationStatus: 'approved',
    monetizationSettings: { adsEnabled: true, adPlacement: 'feed' }
  };
  const campaign = { _id: 'campaign-1', advertiser: { status: 'approved' } };
  const query = {
    sort() { return this; },
    limit(limit) { assert.equal(limit, 30); return this; },
    populate(path, fields) { assert.equal(path, 'advertiser'); assert.match(fields, /website/); return this; },
    lean: async () => [campaign]
  };
  t.mock.method(Community, 'findById', () => ({ lean: async () => community }));
  t.mock.method(Campaign, 'find', (filter) => {
    assert.equal(filter.status, 'active');
    assert.equal(filter.fundingStatus, 'funded');
    assert.equal(filter.targetCommunities, community._id);
    return query;
  });

  assert.deepEqual(await getCommunityCampaigns(community._id), [campaign]);
});

test('sitewide fallback campaigns are available only when no community is monetized', async (t) => {
  let hasMonetizedCommunity = false;
  t.mock.method(Community, 'exists', async (filter) => {
    assert.equal(filter.monetizationStatus, 'approved');
    assert.equal(filter.isMonetized, true);
    assert.equal(filter.isPrivate, false);
    return hasMonetizedCommunity ? { _id: 'monetized-community' } : null;
  });
  const campaign = { _id: 'campaign-global', sitewideFallback: true, advertiser: { status: 'approved' } };
  const query = {
    sort() { return this; },
    limit(limit) { assert.equal(limit, 30); return this; },
    populate(path) { assert.equal(path, 'advertiser'); return this; },
    lean: async () => [campaign]
  };
  const find = t.mock.method(Campaign, 'find', (filter) => {
    assert.equal(filter.sitewideFallback, true);
    assert.deepEqual(filter.targetCommunities, { $size: 0 });
    return query;
  });
  assert.deepEqual(await getSitewideFeedCampaigns(), [campaign]);

  hasMonetizedCommunity = true;
  assert.deepEqual(await getSitewideFeedCampaigns(), []);
  assert.equal(find.mock.callCount(), 1, 'do not query fallback campaigns once monetization is active');
});

test('campaign analytics aggregate delivery by community and date', async (t) => {
  const communityRows = [{
    _id: { campaign: 'campaign-1', community: 'community-1' }, impressions: 10, clicks: 2
  }];
  const dailyRows = [{
    _id: { campaign: 'campaign-1', date: '2026-10-06' }, impressions: 4, clicks: 1
  }];
  let aggregateCall = 0;
  t.mock.method(CampaignEvent, 'aggregate', async () => aggregateCall++ === 0 ? communityRows : dailyRows);
  t.mock.method(Community, 'find', () => ({
    select() { return this; },
    lean: async () => [{ _id: 'community-1', name: 'Design Lab' }]
  }));

  const analytics = await getCampaignAnalytics(['campaign-1'], new Date('2026-10-07T00:00:00Z'));

  assert.deepEqual(analytics.byCommunity, [{
    campaignId: 'campaign-1', communityName: 'Design Lab', impressions: 10, clicks: 2, ctr: 20
  }]);
  assert.deepEqual(analytics.daily, [{
    campaignId: 'campaign-1', date: '2026-10-06', impressions: 4, clicks: 1, ctr: 25
  }]);
});

test('campaign impression tracking is idempotent and atomically updates aggregate counters', async (t) => {
  const community = {
    _id: 'community-1', isPrivate: false, isMonetized: true, monetizationStatus: 'approved',
    monetizationSettings: { adsEnabled: true, adPlacement: 'feed' }
  };
  const campaign = {
    _id: 'campaign-1', status: 'active', fundingStatus: 'funded', remainingBudget: 50,
    impressionCostWaves: 0.25, clickCostWaves: 1.5, dailyBudget: 10,
    destinationUrl: 'https://campaign.example.test/landing',
    targetCommunities: ['community-1'], advertiser: { status: 'approved', website: 'https://example.test' }
  };
  const updateCalls = [];
  let duplicateEvent = false;
  let rapidEventCount = 0;
  let recordedEvent;
  const abuseSignal = t.mock.method(CampaignAbuseSignal, 'findOneAndUpdate', async () => ({}));
  t.mock.method(CampaignEvent, 'countDocuments', async () => rapidEventCount);
  t.mock.method(Community, 'findById', () => ({ lean: async () => community }));
  t.mock.method(Campaign, 'findById', () => ({
    populate() { return this; },
    lean: async () => campaign
  }));
  t.mock.method(CampaignEvent, 'create', async (event) => {
    if (duplicateEvent) {
      const error = new Error('duplicate event');
      error.code = 11000;
      throw error;
    }
    recordedEvent = event;
    return { _id: 'event-1' };
  });

  t.mock.method(Campaign, 'findOneAndUpdate', async (...args) => {
    updateCalls.push(args);
    return { _id: 'campaign-1' };
  });

  const result = await recordCampaignEvent({
    campaignId: 'campaign-1',
    communityId: 'community-1',
    viewerId: 'viewer-1',
    eventType: 'impression',
    eventToken: '12345678-1234-4123-8123-123456789abc'
  });

  assert.equal(result.recorded, true);
  assert.equal(result.wavesCharged, 0.25);
  assert.equal(result.botActivitySignal, false);
  assert.equal(abuseSignal.mock.callCount(), 0);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0][1][0].$set.impressions.$add[1], 1);
  assert.equal(updateCalls[0][1][0].$set.clicks.$add[1], 0);
  assert.equal(updateCalls[0][0].remainingBudget.$gte, 0.25);
  assert.equal(updateCalls[0][1][0].$set.wavesSpent.$round[0].$add[1], 0.25);
  assert.ok(updateCalls[0][0].$expr, 'daily budget must be enforced atomically with event spend');
  assert.match(recordedEvent.viewerDayKey, /^campaign-1:community-1:viewer-1:impression:\d{4}-\d{2}-\d{2}$/);

  // A newly-rendered token must not let the same viewer inflate the same
  // campaign/community's daily event count.
  duplicateEvent = true;
  const duplicate = await recordCampaignEvent({
    campaignId: 'campaign-1',
    communityId: 'community-1',
    viewerId: 'viewer-1',
    eventType: 'impression',
    eventToken: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  });
  assert.equal(duplicate.recorded, false);
  assert.equal(updateCalls.length, 1);
  assert.equal(abuseSignal.mock.callCount(), 1);
  assert.equal(abuseSignal.mock.calls[0].arguments[1].$setOnInsert.attempts, 0);
  assert.equal(abuseSignal.mock.calls[0].arguments[1].$inc.attempts, 1);

  duplicateEvent = false;
  rapidEventCount = 20;
  const click = await recordCampaignEvent({
    campaignId: 'campaign-1',
    communityId: 'community-1',
    viewerId: 'viewer-2',
    eventType: 'click',
    eventToken: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
  });
  assert.equal(click.destinationUrl, 'https://campaign.example.test/landing');
  assert.equal(click.wavesCharged, 1.5);
  assert.equal(click.botActivitySignal, true);
  assert.equal(updateCalls.length, 2);
  assert.equal(updateCalls[1][1][0].$set.clicks.$add[1], 1);
  assert.equal(abuseSignal.mock.callCount(), 2);
  assert.equal(abuseSignal.mock.calls[1].arguments[1].$setOnInsert.eventType, 'bot-activity');
  assert.match(abuseSignal.mock.calls[1].arguments[1].$setOnInsert.reason, /20 unique events within one minute/);
});

test('sitewide campaign events are charged and tracked only during the no-monetized-community fallback', async (t) => {
  const campaign = {
    _id: 'campaign-global', status: 'active', fundingStatus: 'funded', remainingBudget: 20,
    impressionCostWaves: 0.5, clickCostWaves: 2, dailyBudget: 10,
    sitewideFallback: true, targetCommunities: [],
    destinationUrl: 'https://example.test/store',
    advertiser: { status: 'approved', website: 'https://example.test' }
  };
  t.mock.method(Community, 'exists', async () => null);
  t.mock.method(Campaign, 'findById', () => ({
    populate() { return this; },
    lean: async () => campaign
  }));
  let savedEvent;
  t.mock.method(CampaignEvent, 'create', async (event) => {
    savedEvent = event;
    return { _id: 'event-global' };
  });
  t.mock.method(CampaignEvent, 'countDocuments', async () => 1);
  t.mock.method(CampaignAbuseSignal, 'findOneAndUpdate', async () => ({}));
  const update = t.mock.method(Campaign, 'findOneAndUpdate', async (filter) => {
    assert.equal(filter.sitewideFallback, true);
    assert.deepEqual(filter.targetCommunities, { $size: 0 });
    return { _id: campaign._id };
  });
  const result = await recordCampaignEvent({
    campaignId: campaign._id,
    deliveryContext: 'sitewide',
    viewerId: 'viewer-global',
    eventType: 'click',
    eventToken: '11111111-2222-4333-8444-555555555555'
  });
  assert.equal(savedEvent.community, null);
  assert.equal(savedEvent.deliveryContext, 'sitewide');
  assert.match(savedEvent.viewerDayKey, /sitewide:viewer-global:click/);
  assert.equal(result.destinationUrl, 'https://example.test/store');
  assert.equal(result.wavesCharged, 2);
  assert.equal(update.mock.callCount(), 1);
});

test('clicks on already-rendered sitewide ads still reach their destination after monetization starts', async (t) => {
  const campaign = {
    _id: 'campaign-global', status: 'active', fundingStatus: 'funded', remainingBudget: 20,
    impressionCostWaves: 0.5, clickCostWaves: 2, dailyBudget: 10,
    sitewideFallback: true, targetCommunities: [],
    destinationUrl: 'https://example.test/store',
    advertiser: { status: 'approved', website: 'https://example.test' }
  };
  t.mock.method(Community, 'exists', async () => ({ _id: 'newly-monetized-community' }));
  t.mock.method(Campaign, 'findById', () => ({
    populate() { return this; },
    lean: async () => campaign
  }));
  t.mock.method(CampaignEvent, 'create', async () => ({ _id: 'event-global-click' }));
  t.mock.method(CampaignEvent, 'countDocuments', async () => 1);
  t.mock.method(CampaignAbuseSignal, 'findOneAndUpdate', async () => ({}));
  t.mock.method(Campaign, 'findOneAndUpdate', async () => ({ _id: campaign._id }));

  const result = await recordCampaignEvent({
    campaignId: campaign._id,
    deliveryContext: 'sitewide',
    viewerId: 'viewer-global',
    eventType: 'click',
    eventToken: '11111111-2222-4333-8444-555555555555'
  });

  assert.equal(result.destinationUrl, 'https://example.test/store');
  assert.equal(result.wavesCharged, 2);
  await assert.rejects(() => recordCampaignEvent({
    campaignId: campaign._id,
    deliveryContext: 'sitewide',
    viewerId: 'another-viewer',
    eventType: 'impression',
    eventToken: '11111111-2222-4333-8444-666666666666'
  }), /Crowdwide-feed advertisements are unavailable/i);
});

test('admin closes an advertisement abuse signal with a reason and audit record', async (t) => {
  const signal = {
    _id: 'signal-1',
    campaign: 'campaign-1',
    community: 'community-1',
    viewer: 'viewer-1',
    eventType: 'click',
    attempts: 4,
    status: 'open',
    async save() { return this; }
  };
  t.mock.method(CampaignAbuseSignal, 'findOne', async () => signal);
  const auditCreate = t.mock.method(AuditLog, 'create', async (entry) => entry);
  const req = {
    params: { id: signal._id },
    body: { reviewNote: 'Duplicate daily clicks were reviewed.' },
    roleUser: { _id: 'admin-1' },
    ip: '127.0.0.1',
    get: () => 'test-agent',
    session: { flash: null }
  };
  const res = { redirect(path) { this.path = path; } };

  await adminController.reviewAdAbuseSignal(req, res);

  assert.equal(signal.status, 'reviewed');
  assert.equal(signal.reviewNote, req.body.reviewNote);
  assert.equal(auditCreate.mock.callCount(), 1);
  assert.equal(res.path, '/admin#overview');
});

test('campaign clicks reject non-HTTP destinations instead of redirecting to arbitrary schemes', async (t) => {
  const community = {
    _id: 'community-1', isPrivate: false, isMonetized: true, monetizationStatus: 'approved',
    monetizationSettings: { adsEnabled: true, adPlacement: 'feed' }
  };
  const campaign = {
    _id: 'campaign-1', status: 'active', fundingStatus: 'funded', remainingBudget: 50,
    targetCommunities: ['community-1'], advertiser: { status: 'approved', website: 'javascript:alert(1)' }
  };
  let eventRecorded = false;
  t.mock.method(Community, 'findById', () => ({ lean: async () => community }));
  t.mock.method(Campaign, 'findById', () => ({
    populate() { return this; },
    lean: async () => campaign
  }));
  t.mock.method(CampaignEvent, 'create', async () => { eventRecorded = true; });

  await assert.rejects(recordCampaignEvent({
    campaignId: 'campaign-1',
    communityId: 'community-1',
    viewerId: 'viewer-1',
    eventType: 'click',
    eventToken: '12345678-1234-4123-8123-123456789abc'
  }), /valid destination/);
  assert.equal(eventRecorded, false);
});

test('member ad reports enter the existing moderation queue with ad and community context', async (t) => {
  let report;
  t.mock.method(Campaign, 'findById', () => ({
    select() { return this; },
    lean: async () => ({ _id: 'campaign-1', title: 'Example campaign', targetCommunities: ['community-1'] })
  }));
  t.mock.method(Community, 'findById', () => ({
    select() { return this; },
    lean: async () => ({ slug: 'design-lab' })
  }));
  t.mock.method(Report, 'updateOne', async (filter, update) => {
    report = { filter, data: update.$setOnInsert };
  });

  const req = {
    params: { id: 'campaign-1' },
    body: { communityId: 'community-1', reason: 'Inappropriate content' },
    session: { user: { id: 'viewer-1' } }
  };
  const res = { redirect(path) { this.path = path; } };
  await advertisingController.reportCampaign(req, res);

  assert.equal(res.path, '/communities/design-lab');
  assert.equal(report.filter.targetType, 'advertisement');
  assert.equal(report.data.reason, 'Inappropriate content');
  assert.match(report.data.contextText, /Example campaign.*design-lab/);
  assert.equal(req.session.flash.type, 'success');
});

test('sitewide fallback ad reports enter moderation with Crowdwide-feed context', async (t) => {
  let report;
  t.mock.method(Campaign, 'findById', () => ({
    select() { return this; },
    lean: async () => ({ _id: 'campaign-global', title: 'Example campaign', targetCommunities: [], sitewideFallback: true })
  }));
  t.mock.method(Community, 'exists', async () => null);
  t.mock.method(Report, 'updateOne', async (filter, update) => {
    report = { filter, data: update.$setOnInsert };
  });
  const req = {
    params: { id: 'campaign-global' },
    body: { deliveryContext: 'sitewide', reason: 'Misleading or deceptive' },
    session: { user: { id: 'viewer-1' } }
  };
  const res = { redirect(path) { this.path = path; } };
  await advertisingController.reportCampaign(req, res);

  assert.equal(res.path, '/dashboard');
  assert.equal(report.filter.targetType, 'advertisement');
  assert.match(report.data.contextText, /Example campaign.*Crowdwide feed/);
  assert.equal(req.session.flash.type, 'success');
});

test('admin can configure or temporarily disable ads on an approved community', async (t) => {
  const community = {
    _id: 'community-1',
    monetizationStatus: 'approved',
    isMonetized: true,
    monetizationSettings: { adsEnabled: true, adPlacement: 'feed', adFrequency: 1 },
    async save() { this.saved = true; }
  };
  let auditEntry;
  t.mock.method(Community, 'findById', async () => community);
  t.mock.method(AuditLog, 'create', async (entry) => { auditEntry = entry; });
  const req = {
    params: { id: 'community-1' },
    body: { updateAdvertisingSettings: 'on', adPlacement: 'sidebar', adFrequency: '3' },
    roleUser: { _id: 'admin-1' },
    ip: '127.0.0.1',
    get: () => 'test-agent',
    session: {}
  };
  const res = { redirect(path) { this.path = path; } };

  await adminController.updateCommunity(req, res);

  assert.equal(community.monetizationSettings.adsEnabled, false);
  assert.equal(community.monetizationSettings.adPlacement, 'sidebar');
  assert.equal(community.monetizationSettings.adFrequency, 3);
  assert.equal(community.saved, true);
  assert.equal(auditEntry.action, 'edit-community');
  assert.deepEqual(auditEntry.details.advertisingSettings, {
    adsEnabled: false, adPlacement: 'sidebar', adFrequency: 3
  });
});

test('updateCampaignStatus writes moderation changes and rejection reason', async (t) => {
  const campaign = {
    _id: 'campaign-2',
    status: 'submitted',
    moderatorReview: { status: 'flagged', reason: 'Policy concern' },
    moderationHistory: [],
    rejectionReason: '',
    async save() {
      return this;
    }
  };

  t.mock.method(Campaign, 'findById', async () => campaign);

  const updated = await updateCampaignStatus({
    campaignId: 'campaign-2',
    status: 'rejected',
    rejectionReason: 'Not compliant',
    actorId: 'admin-9'
  });

  assert.equal(updated.status, 'rejected');
  assert.equal(updated.rejectionReason, 'Not compliant');
  assert.equal(updated.moderationHistory.length, 1);
  assert.equal(updated.moderationHistory[0].actor, 'admin-9');
});

test('moderator campaign review records a clearance or flag before final admin action', async (t) => {
  const campaign = {
    _id: 'campaign-moderator-review',
    status: 'submitted',
    moderatorReview: { status: 'pending' },
    async save() {
      return this;
    }
  };
  t.mock.method(Campaign, 'findById', async () => campaign);

  const reviewed = await reviewCampaignAsModerator({
    campaignId: campaign._id,
    decision: 'cleared',
    reason: 'Campaign copy and targeting reviewed.',
    policyChecks: ['adult-18-plus', 'sexual-content', 'gambling-betting', 'pornography', 'other-inappropriate'],
    moderatorId: 'moderator-1'
  });
  assert.equal(reviewed.moderatorReview.status, 'cleared');
  assert.equal(reviewed.moderatorReview.reviewedBy, 'moderator-1');
  assert.equal(reviewed.moderatorReview.policyChecks.length, 5);
  assert.ok(reviewed.moderatorReview.reviewedAt instanceof Date);
  await assert.rejects(() => reviewCampaignAsModerator({
    campaignId: campaign._id,
    decision: 'flagged',
    reason: 'Second review attempt.',
    moderatorId: 'moderator-2'
  }), /already received a moderator review/i);
});

test('updateAdvertiserStatus records admin approval and verification history', async (t) => {
  const advertiser = {
    _id: 'advertiser-review',
    status: 'pending',
    isVerified: false,
    moderatorReview: { status: 'cleared', reason: 'Business details reviewed.' },
    moderationHistory: [],
    async save() {
      return this;
    }
  };
  t.mock.method(Advertiser, 'findById', async () => advertiser);

  const updated = await updateAdvertiserStatus({
    advertiserId: advertiser._id,
    status: 'approved',
    actorId: 'admin-1'
  });

  assert.equal(updated.status, 'approved');
  assert.equal(updated.isVerified, true);
  assert.equal(updated.reviewedBy, 'admin-1');
  assert.equal(updated.moderationHistory[0].actor, 'admin-1');
});

test('moderator screens advertiser applications and final approval requires clearance', async (t) => {
  const advertiser = {
    _id: 'advertiser-moderator-review',
    status: 'pending',
    moderatorReview: { status: 'pending' },
    async save() {
      return this;
    }
  };
  t.mock.method(Advertiser, 'findById', async () => advertiser);

  const reviewed = await reviewAdvertiserAsModerator({
    advertiserId: advertiser._id,
    decision: 'cleared',
    reason: 'Business and destination appear suitable.',
    moderatorId: 'moderator-1'
  });
  assert.equal(reviewed.moderatorReview.status, 'cleared');
  assert.equal(reviewed.moderatorReview.reviewedBy, 'moderator-1');
  assert.ok(reviewed.moderatorReview.reviewedAt instanceof Date);

  const updated = await updateAdvertiserStatus({
    advertiserId: advertiser._id,
    status: 'approved',
    actorId: 'admin-1'
  });
  assert.equal(updated.status, 'approved');
});

test('admin cannot approve an advertiser before moderator screening or when flagged', async (t) => {
  const advertiser = {
    _id: 'advertiser-flagged',
    status: 'pending',
    moderatorReview: { status: 'pending' },
    async save() {
      return this;
    }
  };
  t.mock.method(Advertiser, 'findById', async () => advertiser);

  await assert.rejects(() => updateAdvertiserStatus({
    advertiserId: advertiser._id,
    status: 'approved',
    actorId: 'admin-1'
  }), /moderator screening must be completed/i);

  advertiser.moderatorReview = { status: 'flagged', reason: 'Needs further checks.' };
  await assert.rejects(() => updateAdvertiserStatus({
    advertiserId: advertiser._id,
    status: 'approved',
    actorId: 'admin-1'
  }), /approval requires a moderator review that clears/i);
});

test('submitted campaign cannot be rejected without a reason or activated before approval', async (t) => {
  const campaign = {
    _id: 'campaign-awaiting-review',
    status: 'submitted',
    isWavesFunded: true,
    fundingStatus: 'funded',
    moderatorReview: { status: 'pending' },
    moderationHistory: [],
    async save() {
      return this;
    }
  };
  t.mock.method(Campaign, 'findById', async () => campaign);

  await assert.rejects(() => updateCampaignStatus({
    campaignId: campaign._id,
    status: 'rejected'
  }), /rejection reason is required/i);
  await assert.rejects(() => updateCampaignStatus({
    campaignId: campaign._id,
    status: 'active'
  }), /only be approved or rejected/i);
  await assert.rejects(() => updateCampaignStatus({
    campaignId: campaign._id,
    status: 'approved'
  }), /rejection reason is required|moderation must be completed/i);
});

test('admin cannot approve a flagged campaign after moderator review', async (t) => {
  const campaign = {
    _id: 'campaign-flagged',
    status: 'submitted',
    moderatorReview: { status: 'flagged', reason: 'Prohibited content concern.' },
    async save() {
      return this;
    }
  };
  t.mock.method(Campaign, 'findById', async () => campaign);

  await assert.rejects(() => updateCampaignStatus({
    campaignId: campaign._id,
    status: 'approved',
    actorId: 'admin-1'
  }), /approval requires a moderator review that clears/i);
});

test('admin can suspend and reinstate an approved campaign with auditable reasons', async (t) => {
  const campaign = {
    _id: 'campaign-admin-suspension',
    status: 'active',
    isWavesFunded: true,
    fundingStatus: 'funded',
    remainingBudget: 25,
    moderationHistory: [],
    async save() {
      return this;
    }
  };
  t.mock.method(Campaign, 'findById', async () => campaign);

  const suspended = await updateCampaignStatus({
    campaignId: campaign._id,
    status: 'suspended',
    reason: 'Policy investigation in progress.',
    actorId: 'admin-1'
  });
  assert.equal(suspended.status, 'suspended');
  assert.equal(suspended.suspensionReason, 'Policy investigation in progress.');
  assert.equal(suspended.suspendedBy, 'admin-1');
  assert.equal(suspended.remainingBudget, 25);
  assert.equal(suspended.moderationHistory.at(-1).reason, 'Policy investigation in progress.');
  await assert.rejects(() => updateCampaignStatus({
    campaignId: campaign._id,
    status: 'active',
    actorId: 'advertiser-1'
  }), /only approved campaigns can be activated/i);

  const reinstated = await updateCampaignStatus({
    campaignId: campaign._id,
    status: 'approved',
    reason: 'Review found no remaining concern.',
    actorId: 'admin-1'
  });
  assert.equal(reinstated.status, 'approved');
  assert.equal(reinstated.suspensionReason, '');
  assert.equal(reinstated.moderationHistory.at(-1).reason, 'Review found no remaining concern.');
});

test('moderator cannot clear without every prohibited-ad policy check or flag without a category', async (t) => {
  const campaign = {
    _id: 'campaign-policy-checks',
    status: 'submitted',
    moderatorReview: { status: 'pending' },
    async save() {
      return this;
    }
  };
  t.mock.method(Campaign, 'findById', async () => campaign);

  await assert.rejects(() => reviewCampaignAsModerator({
    campaignId: campaign._id,
    decision: 'cleared',
    reason: 'Quick review.',
    policyChecks: ['adult-18-plus'],
    moderatorId: 'moderator-1'
  }), /confirm every prohibited-ad policy check/i);
  await assert.rejects(() => reviewCampaignAsModerator({
    campaignId: campaign._id,
    decision: 'flagged',
    reason: 'Appears to promote betting.',
    moderatorId: 'moderator-1'
  }), /choose a prohibited-ad category/i);
});
