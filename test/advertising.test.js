const test = require('node:test');
const assert = require('node:assert/strict');

const Advertiser = require('../src/models/Advertiser');
const Campaign = require('../src/models/Campaign');
const {
  calculateCtr,
  createCampaign,
  recordCampaignPerformance,
  registerAdvertiser,
  updateCampaignStatus
} = require('../src/services/advertising');

test('registerAdvertiser creates an advertiser profile for a user', async (t) => {
  const originalFindOneAndUpdate = Advertiser.findOneAndUpdate;
  const stub = t.mock.method(Advertiser, 'findOneAndUpdate', async (query, update) => ({
    _id: 'advertiser-1',
    user: query.user,
    businessName: update.businessName,
    website: update.website,
    notes: update.notes,
    isVerified: update.isVerified,
    status: update.status
  }));

  const advertiser = await registerAdvertiser({
    userId: 'user-1',
    businessName: 'Crowdwide Ads',
    website: 'https://example.com',
    notes: 'Launch campaign soon',
    isVerified: true
  });

  assert.equal(advertiser.businessName, 'Crowdwide Ads');
  assert.equal(advertiser.status, 'pending');
  assert.equal(stub.mock.callCount(), 1);

  Advertiser.findOneAndUpdate = originalFindOneAndUpdate;
});

test('createCampaign rejects unapproved advertisers and enforces daily budget limits', async (t) => {
  t.mock.method(Advertiser, 'findById', async (id) => {
    if (String(id) === 'advertiser-1') {
      return { _id: 'advertiser-1', status: 'pending' };
    }
    return { _id: 'advertiser-2', status: 'approved' };
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
    totalBudget: 100,
    dailyBudget: 40,
    startDate: '2026-01-01',
    endDate: '2026-01-05'
  });

  assert.equal(campaign.status, 'submitted');
  assert.equal(campaign.remainingBudget, 100);
  assert.equal(createCampaignEntry.mock.callCount(), 1);
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

test('updateCampaignStatus writes moderation changes and rejection reason', async (t) => {
  const campaign = {
    _id: 'campaign-2',
    status: 'submitted',
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
