const test = require('node:test');
const assert = require('node:assert/strict');

const Advertiser = require('../src/models/Advertiser');
const Campaign = require('../src/models/Campaign');
const User = require('../src/models/User');
const WavesLedgerEntry = require('../src/models/WavesLedgerEntry');
const {
  calculateCtr,
  createCampaign,
  fundCampaign,
  refundCampaignBudget,
  recordCampaignPerformance,
  registerAdvertiser,
  reviewCampaignAsModerator,
  submitCampaign,
  spendCampaignBudget,
  updateAdvertiserStatus,
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
    endDate: '2026-01-05',
    status: 'draft'
  });

  assert.equal(campaign.status, 'draft');
  assert.equal(campaign.remainingBudget, 0);
  assert.equal(createCampaignEntry.mock.callCount(), 1);
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
  t.mock.method(Advertiser, 'findById', async () => ({ user: 'owner-1', status: 'approved' }));
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
  t.mock.method(Advertiser, 'findById', async () => ({ user: 'owner-poor', status: 'approved' }));
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
    moderatorId: 'moderator-1'
  });
  assert.equal(reviewed.moderatorReview.status, 'cleared');
  assert.equal(reviewed.moderatorReview.reviewedBy, 'moderator-1');
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
