const Advertiser = require('../models/Advertiser');
const Campaign = require('../models/Campaign');

function normalizeNonNegativeNumber(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${fieldName} must be a non-negative number.`);
  }
  return parsed;
}

function normalizePositiveNumber(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be greater than zero.`);
  }
  return parsed;
}

function calculateCtr({ impressions = 0, clicks = 0 }) {
  const impressionCount = normalizeNonNegativeNumber(impressions, 'impressions');
  const clickCount = normalizeNonNegativeNumber(clicks, 'clicks');
  if (impressionCount === 0) return 0;
  return Number(((clickCount / impressionCount) * 100).toFixed(4));
}

async function registerAdvertiser({ userId, businessName, website = '', notes = '', isVerified = false }) {
  if (!userId) throw new Error('Advertiser user ID is required.');

  const name = String(businessName || '').trim();
  if (!name) throw new Error('Business name is required.');

  const advertiser = await Advertiser.findOneAndUpdate(
    { user: userId },
    {
      user: userId,
      businessName: name,
      website: String(website || '').trim().slice(0, 300),
      notes: String(notes || '').trim().slice(0, 2000),
      isVerified: Boolean(isVerified),
      status: 'pending',
      reviewedAt: Date.now(),
      updatedAt: new Date()
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return advertiser;
}

async function createCampaign({
  advertiserId,
  title,
  description = '',
  totalBudget,
  dailyBudget = 0,
  startDate,
  endDate,
  targetCommunities = [],
  isWavesFunded = true,
  status = 'submitted',
  notes = '',
  createdByAdmin = false
}) {
  if (!advertiserId) throw new Error('Advertiser ID is required.');

  const advertiser = await Advertiser.findById(advertiserId);
  if (!advertiser) throw new Error('Advertiser not found.');
  if (advertiser.status !== 'approved') {
    throw new Error('Only approved advertisers can create campaigns.');
  }

  const cleanedTitle = String(title || '').trim();
  if (!cleanedTitle) throw new Error('Campaign title is required.');

  const budget = normalizePositiveNumber(totalBudget, 'totalBudget');
  const daily = normalizeNonNegativeNumber(dailyBudget, 'dailyBudget');
  if (daily > budget) {
    throw new Error('Daily budget cannot exceed total budget.');
  }

  if (startDate && endDate && new Date(endDate) < new Date(startDate)) {
    throw new Error('End date cannot be before the start date.');
  }

  const campaign = await Campaign.create({
    advertiser: advertiserId,
    title: cleanedTitle,
    description: String(description || '').trim().slice(0, 2000),
    totalBudget: budget,
    dailyBudget: daily,
    remainingBudget: budget,
    startDate: startDate ? new Date(startDate) : null,
    endDate: endDate ? new Date(endDate) : null,
    targetCommunities: Array.isArray(targetCommunities) ? targetCommunities : [],
    isWavesFunded: Boolean(isWavesFunded),
    notes: String(notes || '').trim().slice(0, 2000),
    status,
    createdByAdmin: Boolean(createdByAdmin)
  });

  return campaign;
}

async function updateCampaignStatus({ campaignId, status, rejectionReason = '', actorId = null }) {
  if (!campaignId) throw new Error('Campaign ID is required.');

  const campaign = await Campaign.findById(campaignId);
  if (!campaign) throw new Error('Campaign not found.');

  const nextStatus = String(status || '').trim();
  const validStatuses = ['draft', 'submitted', 'approved', 'rejected', 'active', 'paused', 'cancelled', 'completed'];
  if (!validStatuses.includes(nextStatus)) {
    throw new Error(`Invalid campaign status: ${nextStatus}`);
  }

  campaign.status = nextStatus;
  campaign.reviewedAt = new Date();
  campaign.reviewedBy = actorId || campaign.reviewedBy || null;
  campaign.rejectionReason = nextStatus === 'rejected' ? String(rejectionReason || '').trim().slice(0, 500) : '';

  if (nextStatus === 'approved') campaign.approvedAt = new Date();
  if (nextStatus === 'paused') campaign.pausedAt = new Date();
  if (nextStatus === 'cancelled') campaign.cancelledAt = new Date();

  campaign.moderationHistory = [
    ...(campaign.moderationHistory || []).slice(-9),
    {
      status: nextStatus,
      reason: nextStatus === 'rejected' ? campaign.rejectionReason : '',
      createdAt: new Date(),
      actor: actorId || null
    }
  ];

  await campaign.save();
  return campaign;
}

async function recordCampaignPerformance({ campaignId, impressions = 0, clicks = 0 }) {
  const campaign = await Campaign.findById(campaignId);
  if (!campaign) throw new Error('Campaign not found.');

  const nextImpressions = normalizeNonNegativeNumber(impressions, 'impressions');
  const nextClicks = normalizeNonNegativeNumber(clicks, 'clicks');

  campaign.impressions += nextImpressions;
  campaign.clicks += nextClicks;
  campaign.ctr = calculateCtr({ impressions: campaign.impressions, clicks: campaign.clicks });
  await campaign.save();

  return campaign;
}

async function spendCampaignBudget({ campaignId, amount }) {
  const campaign = await Campaign.findById(campaignId);
  if (!campaign) throw new Error('Campaign not found.');

  const spend = normalizeNonNegativeNumber(amount, 'amount');
  if (spend > campaign.remainingBudget) {
    throw new Error('Campaign spend exceeds remaining budget.');
  }

  campaign.remainingBudget = Number((campaign.remainingBudget - spend).toFixed(6));
  campaign.wavesSpent = Number((campaign.wavesSpent + spend).toFixed(6));
  if (campaign.remainingBudget <= 0) {
    campaign.status = 'completed';
  }

  await campaign.save();
  return campaign;
}

async function getCampaignSummary(campaignId) {
  const campaign = await Campaign.findById(campaignId).lean();
  if (!campaign) return null;

  return {
    id: campaign._id,
    status: campaign.status,
    impressions: Number(campaign.impressions || 0),
    clicks: Number(campaign.clicks || 0),
    ctr: Number(campaign.ctr || 0),
    totalBudget: Number(campaign.totalBudget || 0),
    remainingBudget: Number(campaign.remainingBudget || 0),
    wavesSpent: Number(campaign.wavesSpent || 0)
  };
}

module.exports = {
  calculateCtr,
  createCampaign,
  getCampaignSummary,
  recordCampaignPerformance,
  registerAdvertiser,
  spendCampaignBudget,
  updateCampaignStatus
};
