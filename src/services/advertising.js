const Advertiser = require('../models/Advertiser');
const Campaign = require('../models/Campaign');
const User = require('../models/User');
const WavesLedgerEntry = require('../models/WavesLedgerEntry');

const ADVERTISING_TERMS_VERSION = '2026-10-07';
const ADVERTISING_POLICY_CATEGORIES = [
  'adult-18-plus',
  'sexual-content',
  'gambling-betting',
  'pornography',
  'other-inappropriate'
];

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

async function registerAdvertiser({ userId, businessName, website = '', notes = '', isVerified = false, acceptedTerms = false }) {
  if (!userId) throw new Error('Advertiser user ID is required.');

  const name = String(businessName || '').trim();
  if (!name) throw new Error('Business name is required.');
  if (!acceptedTerms) throw new Error('You must accept the Advertising Terms to apply.');

  const advertiser = await Advertiser.findOneAndUpdate(
    { user: userId },
    {
      user: userId,
      businessName: name,
      website: String(website || '').trim().slice(0, 300),
      notes: String(notes || '').trim().slice(0, 2000),
      isVerified: Boolean(isVerified),
      status: 'pending',
      termsAcceptedAt: new Date(),
      termsVersion: ADVERTISING_TERMS_VERSION,
      moderatorReview: { status: 'pending', reason: '', reviewedAt: null, reviewedBy: null },
      reviewedAt: null,
      reviewedBy: null,
      updatedAt: new Date()
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return advertiser;
}

async function reviewAdvertiserAsModerator({ advertiserId, decision, reason = '', moderatorId }) {
  if (!advertiserId) throw new Error('Advertiser ID is required.');
  if (!moderatorId) throw new Error('Moderator ID is required.');

  const advertiser = await Advertiser.findById(advertiserId);
  if (!advertiser) throw new Error('Advertiser not found.');
  if (advertiser.status !== 'pending') throw new Error('Only pending advertiser applications can be reviewed.');
  if (advertiser.moderatorReview?.status !== 'pending') throw new Error('This advertiser has already received a moderator review.');
  if (!['cleared', 'flagged'].includes(decision)) throw new Error('Choose clear or flag for advertiser review.');

  const note = String(reason || '').trim().slice(0, 500);
  if (decision === 'flagged' && !note) throw new Error('A reason is required to flag an advertiser.');
  advertiser.moderatorReview = {
    status: decision,
    reason: note || 'No policy concerns identified.',
    reviewedAt: new Date(),
    reviewedBy: moderatorId
  };
  await advertiser.save();
  return advertiser;
}

async function updateAdvertiserStatus({ advertiserId, status, reason = '', actorId }) {
  const advertiser = await Advertiser.findById(advertiserId);
  if (!advertiser) throw new Error('Advertiser not found.');
  const nextStatus = String(status || '').trim();
  if (!['approved', 'rejected', 'suspended'].includes(nextStatus)) {
    throw new Error(`Invalid advertiser status: ${nextStatus}`);
  }
  const note = String(reason || '').trim().slice(0, 500);
  if (['rejected', 'suspended'].includes(nextStatus) && !note) {
    throw new Error('A reason is required to reject or suspend an advertiser.');
  }
  if (advertiser.status === 'pending' && ['approved', 'rejected'].includes(nextStatus)
    && !['cleared', 'flagged'].includes(advertiser.moderatorReview?.status)) {
    throw new Error('Moderator screening must be completed before final advertiser review.');
  }
  if (nextStatus === 'approved' && advertiser.moderatorReview?.status !== 'cleared') {
    throw new Error('Advertiser approval requires a moderator review that clears the application.');
  }
  advertiser.status = nextStatus;
  advertiser.reviewedAt = new Date();
  advertiser.reviewedBy = actorId;
  advertiser.rejectionReason = nextStatus === 'rejected' ? note : '';
  if (nextStatus === 'approved') advertiser.approvedAt = new Date();
  if (nextStatus === 'suspended') advertiser.suspendedAt = new Date();
  if (nextStatus === 'approved' && !advertiser.isVerified) {
    advertiser.isVerified = true;
    advertiser.verifiedAt = new Date();
  }
  advertiser.moderationHistory = [
    ...(advertiser.moderationHistory || []).slice(-9),
    { status: nextStatus, reason: note, createdAt: new Date(), actor: actorId }
  ];
  await advertiser.save();
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
  status = 'draft',
  notes = '',
  createdByAdmin = false
}) {
  if (!advertiserId) throw new Error('Advertiser ID is required.');

  const advertiser = await Advertiser.findById(advertiserId);
  if (!advertiser) throw new Error('Advertiser not found.');
  if (advertiser.status !== 'approved') {
    throw new Error('Only approved advertisers can create campaigns.');
  }
  if (advertiser.termsVersion !== ADVERTISING_TERMS_VERSION || !advertiser.termsAcceptedAt) {
    throw new Error('Accept the current Advertising Terms before creating campaigns.');
  }
  if (status !== 'draft') throw new Error('New campaigns must start as drafts and be submitted for review separately.');
  if (!isWavesFunded) throw new Error('Campaign funding is currently supported only with Waves.');

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
    remainingBudget: 0,
    startDate: startDate ? new Date(startDate) : null,
    endDate: endDate ? new Date(endDate) : null,
    targetCommunities: Array.isArray(targetCommunities) ? targetCommunities : [],
    isWavesFunded: Boolean(isWavesFunded),
    notes: String(notes || '').trim().slice(0, 2000),
    status: 'draft',
    fundingStatus: 'unfunded',
    createdByAdmin: Boolean(createdByAdmin)
  });

  return campaign;
}

async function submitCampaign({ campaignId, actorId = null }) {
  const campaign = await Campaign.findById(campaignId);
  if (!campaign) throw new Error('Campaign not found.');
  if (campaign.status === 'submitted' && campaign.fundingStatus === 'funded') return campaign;
  if (campaign.status !== 'draft') throw new Error('Only draft campaigns can be submitted.');
  return fundCampaign({ campaignId, actorId });
}

async function fundCampaign({ campaignId, actorId = null }) {
  const campaign = await Campaign.findById(campaignId);
  if (!campaign) throw new Error('Campaign not found.');
  if (!campaign.isWavesFunded) throw new Error('Only Waves-funded campaigns can be funded from a Waves wallet.');
  if (campaign.fundingStatus === 'funded') return campaign;
  if (campaign.fundingStatus !== 'unfunded') throw new Error('Campaign funding is not available in its current state.');
  if (!['draft', 'submitted'].includes(campaign.status)) {
    throw new Error('Only draft or submitted campaigns can be funded.');
  }

  const advertiser = await Advertiser.findById(campaign.advertiser);
  if (!advertiser || advertiser.status !== 'approved') {
    throw new Error('An approved advertiser is required to fund a campaign.');
  }
  if (advertiser.termsVersion !== ADVERTISING_TERMS_VERSION || !advertiser.termsAcceptedAt) {
    throw new Error('Accept the current Advertising Terms before funding a campaign.');
  }
  const amount = normalizePositiveNumber(campaign.totalBudget, 'campaign budget');
  const rewardKey = `campaign-fund:${campaign._id}`;
  let entry;
  try {
    entry = await WavesLedgerEntry.create({
      user: advertiser.user,
      amount: -amount,
      type: 'campaign',
      status: 'pending',
      description: `Fund campaign: ${campaign.title}`,
      reason: 'Campaign budget escrow',
      actor: actorId || advertiser.user,
      referenceType: 'campaign',
      referenceId: campaign._id,
      rewardKey
    });
  } catch (error) {
    if (error?.code === 11000) {
      const existing = await WavesLedgerEntry.findOne({ rewardKey });
      if (existing?.status === 'posted' && existing.amount === -amount) {
        campaign.fundingUser = advertiser.user;
        campaign.fundingStatus = 'funded';
        campaign.remainingBudget = amount;
        campaign.status = 'submitted';
        campaign.moderatorReview = { status: 'pending', reason: '', reviewedAt: null, reviewedBy: null };
        await campaign.save();
        return campaign;
      }
      if (existing) throw new Error('Campaign funding is already being processed.');
    }
    throw error;
  }

  const debit = await User.updateOne(
    { _id: advertiser.user, wavesBalance: { $gte: amount } },
    { $inc: { wavesBalance: -amount, wavesTotalSpent: amount } }
  );
  if (!debit.modifiedCount) {
    entry.status = 'reversed';
    entry.reason = 'Campaign funding failed: insufficient Waves balance.';
    entry.rewardKey = undefined;
    await entry.save();
    throw new Error('Insufficient Waves balance to fund this campaign.');
  }

  const user = await User.findById(advertiser.user).select('wavesBalance').lean();
  entry.balanceAfter = Number(user?.wavesBalance || 0);
  entry.status = 'posted';
  await entry.save();

  campaign.fundingUser = advertiser.user;
  campaign.fundingStatus = 'funded';
  campaign.remainingBudget = amount;
  campaign.status = campaign.status === 'draft' ? 'submitted' : campaign.status;
  campaign.moderatorReview = { status: 'pending', reason: '', reviewedAt: null, reviewedBy: null };
  campaign.moderationHistory = [
    ...(campaign.moderationHistory || []).slice(-9),
    { status: campaign.status, reason: 'Campaign budget funded with Waves.', createdAt: new Date(), actor: actorId || advertiser.user }
  ];
  await campaign.save();
  return campaign;
}

async function reviewCampaignAsModerator({ campaignId, decision, reason = '', flaggedCategory = '', policyChecks = [], moderatorId }) {
  if (!campaignId) throw new Error('Campaign ID is required.');
  if (!moderatorId) throw new Error('Moderator ID is required.');

  const campaign = await Campaign.findById(campaignId);
  if (!campaign) throw new Error('Campaign not found.');
  if (campaign.status !== 'submitted') throw new Error('Only submitted campaigns can be reviewed.');
  if (campaign.moderatorReview?.status !== 'pending') throw new Error('This campaign has already received a moderator review.');
  if (!['cleared', 'flagged'].includes(decision)) throw new Error('Choose clear or flag for campaign review.');

  const note = String(reason || '').trim().slice(0, 500);
  const category = String(flaggedCategory || '').trim();
  const checks = [...new Set((Array.isArray(policyChecks) ? policyChecks : [policyChecks])
    .map((value) => String(value || '').trim())
    .filter((value) => ADVERTISING_POLICY_CATEGORIES.includes(value)))];
  if (decision === 'flagged' && (!note || !ADVERTISING_POLICY_CATEGORIES.includes(category))) {
    throw new Error('Choose a prohibited-ad category and provide a reason to flag a campaign.');
  }
  if (decision === 'cleared' && ADVERTISING_POLICY_CATEGORIES.some((value) => !checks.includes(value))) {
    throw new Error('Confirm every prohibited-ad policy check before clearing this campaign.');
  }
  campaign.moderatorReview = {
    status: decision,
    reason: note || 'No policy concerns identified.',
    flaggedCategory: decision === 'flagged' ? category : '',
    policyChecks: decision === 'cleared' ? ADVERTISING_POLICY_CATEGORIES : checks,
    reviewedAt: new Date(),
    reviewedBy: moderatorId
  };
  await campaign.save();
  return campaign;
}

async function refundCampaignBudget({ campaignId, reason = 'Unused campaign budget refund', actorId = null }) {
  const campaign = await Campaign.findById(campaignId);
  if (!campaign) throw new Error('Campaign not found.');
  if (!campaign.isWavesFunded) throw new Error('Only Waves-funded campaigns can be refunded to a Waves wallet.');
  if (campaign.fundingStatus === 'refunded' || campaign.remainingBudget <= 0) return campaign;
  if (!['rejected', 'cancelled', 'completed'].includes(campaign.status)) {
    throw new Error('Campaign must be rejected, cancelled, or completed before unused budget is refunded.');
  }
  if (!campaign.fundingUser) throw new Error('Campaign funding wallet is unavailable.');

  const amount = normalizeNonNegativeNumber(campaign.remainingBudget, 'remaining campaign budget');
  if (amount === 0) return campaign;
  const rewardKey = `campaign-refund:${campaign._id}`;
  let entry;
  try {
    entry = await WavesLedgerEntry.create({
      user: campaign.fundingUser,
      amount,
      type: 'refund',
      status: 'pending',
      description: `Unused budget refund: ${campaign.title}`,
      reason: String(reason || 'Unused campaign budget refund').trim().slice(0, 500),
      actor: actorId || null,
      referenceType: 'campaign',
      referenceId: campaign._id,
      rewardKey
    });
  } catch (error) {
    if (error?.code === 11000) {
      const existing = await WavesLedgerEntry.findOne({ rewardKey });
      if (existing?.status === 'posted' && existing.amount === amount) {
        campaign.refundedBudget = Number(((campaign.refundedBudget || 0) + amount).toFixed(6));
        campaign.remainingBudget = 0;
        campaign.fundingStatus = 'refunded';
        await campaign.save();
        return campaign;
      }
      if (existing) throw new Error('Campaign refund is already being processed.');
    }
    throw error;
  }

  const credit = await User.updateOne(
    { _id: campaign.fundingUser },
    { $inc: { wavesBalance: amount } }
  );
  if (!credit.modifiedCount) {
    entry.status = 'reversed';
    entry.reason = `${entry.reason}; refund failed because the funding account no longer exists`.slice(0, 500);
    await entry.save();
    throw new Error('The campaign funding wallet could not be credited.');
  }

  const user = await User.findById(campaign.fundingUser).select('wavesBalance').lean();
  entry.balanceAfter = Number(user?.wavesBalance || 0);
  entry.status = 'posted';
  await entry.save();

  campaign.refundedBudget = Number(((campaign.refundedBudget || 0) + amount).toFixed(6));
  campaign.remainingBudget = 0;
  campaign.fundingStatus = 'refunded';
  await campaign.save();
  return campaign;
}

async function updateCampaignStatus({ campaignId, status, rejectionReason = '', reason = '', actorId = null }) {
  if (!campaignId) throw new Error('Campaign ID is required.');

  const campaign = await Campaign.findById(campaignId);
  if (!campaign) throw new Error('Campaign not found.');

  const nextStatus = String(status || '').trim();
  const validStatuses = ['draft', 'submitted', 'approved', 'rejected', 'active', 'paused', 'suspended', 'cancelled', 'completed'];
  if (!validStatuses.includes(nextStatus)) {
    throw new Error(`Invalid campaign status: ${nextStatus}`);
  }
  if (campaign.status === 'submitted' && !['approved', 'rejected'].includes(nextStatus)) {
    throw new Error('Submitted campaigns can only be approved or rejected by an admin.');
  }
  if (nextStatus === 'rejected' && !String(rejectionReason || '').trim()) {
    throw new Error('A rejection reason is required.');
  }
  if (nextStatus === 'approved' && !['submitted', 'paused', 'suspended'].includes(campaign.status)) {
    throw new Error('Only submitted or suspended campaigns can be approved or reinstated.');
  }
  if (campaign.status === 'submitted' && ['approved', 'rejected'].includes(nextStatus)
    && !['cleared', 'flagged'].includes(campaign.moderatorReview?.status)) {
    throw new Error('Campaign moderation must be completed before final admin review.');
  }
  if (nextStatus === 'approved' && campaign.status === 'submitted' && campaign.moderatorReview?.status !== 'cleared') {
    throw new Error('Campaign approval requires a moderator review that clears the campaign.');
  }
  if (nextStatus === 'active' && campaign.isWavesFunded && campaign.fundingStatus !== 'funded') {
    throw new Error('Only funded campaigns can be activated.');
  }
  if (nextStatus === 'active' && !['approved', 'paused'].includes(campaign.status)) {
    throw new Error('Only approved campaigns can be activated.');
  }
  if (nextStatus === 'active' && campaign.startDate && campaign.startDate > new Date()) {
    throw new Error('Campaign cannot be activated before its scheduled start date.');
  }
  if (nextStatus === 'active' && campaign.endDate && campaign.endDate < new Date()) {
    throw new Error('Campaign cannot be activated after its scheduled end date.');
  }
  if (nextStatus === 'paused' && !['active', 'approved'].includes(campaign.status)) {
    throw new Error('Only approved or active campaigns can be paused.');
  }
  if (nextStatus === 'suspended' && !['approved', 'active', 'paused'].includes(campaign.status)) {
    throw new Error('Only approved, active, or paused campaigns can be suspended.');
  }
  const moderationReason = String(reason || '').trim().slice(0, 500);
  if (nextStatus === 'suspended' && !moderationReason) {
    throw new Error('A reason is required to suspend a campaign.');
  }
  if (nextStatus === 'cancelled' && !['draft', 'submitted', 'approved', 'active', 'paused', 'suspended'].includes(campaign.status)) {
    throw new Error('This campaign cannot be cancelled in its current state.');
  }

  campaign.status = nextStatus;
  campaign.reviewedAt = new Date();
  campaign.reviewedBy = actorId || campaign.reviewedBy || null;
  campaign.rejectionReason = nextStatus === 'rejected' ? String(rejectionReason || '').trim().slice(0, 500) : '';

  if (nextStatus === 'approved') campaign.approvedAt = new Date();
  if (nextStatus === 'paused') campaign.pausedAt = new Date();
  if (nextStatus === 'suspended') {
    campaign.suspendedAt = new Date();
    campaign.suspendedBy = actorId || null;
    campaign.suspensionReason = moderationReason;
  }
  if (nextStatus === 'approved' && campaign.suspendedAt) {
    campaign.suspendedAt = null;
    campaign.suspendedBy = null;
    campaign.suspensionReason = '';
  }
  if (nextStatus === 'cancelled') campaign.cancelledAt = new Date();

  campaign.moderationHistory = [
    ...(campaign.moderationHistory || []).slice(-9),
    {
      status: nextStatus,
      reason: nextStatus === 'rejected'
        ? campaign.rejectionReason
        : nextStatus === 'suspended' || (nextStatus === 'approved' && moderationReason)
          ? moderationReason
          : '',
      createdAt: new Date(),
      actor: actorId || null
    }
  ];

  await campaign.save();
  if (['rejected', 'cancelled', 'completed'].includes(nextStatus) && campaign.remainingBudget > 0 && campaign.fundingStatus === 'funded') {
    return refundCampaignBudget({
      campaignId: campaign._id,
      reason: nextStatus === 'rejected' ? `Campaign rejected: ${campaign.rejectionReason || 'moderation decision'}` : `Unused budget returned when campaign ${nextStatus}.`,
      actorId
    });
  }
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
  if (campaign.fundingStatus !== 'funded') throw new Error('Campaign budget is not funded.');
  if (!['active', 'approved'].includes(campaign.status)) throw new Error('Campaign is not approved to spend its budget.');

  const spend = normalizeNonNegativeNumber(amount, 'amount');
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dailySpend = campaign.dailyBudgetDate && campaign.dailyBudgetDate >= today
    ? Number(campaign.dailyBudgetSpent || 0)
    : 0;
  const dailyLimit = normalizeNonNegativeNumber(campaign.dailyBudget || 0, 'dailyBudget');
  if (dailyLimit > 0 && dailySpend + spend > dailyLimit) {
    throw new Error('Campaign spend exceeds its daily budget.');
  }
  if (spend > campaign.remainingBudget) {
    throw new Error('Campaign spend exceeds remaining budget.');
  }

  campaign.remainingBudget = Number((campaign.remainingBudget - spend).toFixed(6));
  campaign.wavesSpent = Number((campaign.wavesSpent + spend).toFixed(6));
  campaign.dailyBudgetSpent = Number((dailySpend + spend).toFixed(6));
  campaign.dailyBudgetDate = today;
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
  ADVERTISING_POLICY_CATEGORIES,
  ADVERTISING_TERMS_VERSION,
  calculateCtr,
  createCampaign,
  fundCampaign,
  submitCampaign,
  getCampaignSummary,
  recordCampaignPerformance,
  refundCampaignBudget,
  registerAdvertiser,
  reviewAdvertiserAsModerator,
  reviewCampaignAsModerator,
  spendCampaignBudget,
  updateAdvertiserStatus,
  updateCampaignStatus
};
