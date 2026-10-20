const mongoose = require('mongoose');
const Advertiser = require('../models/Advertiser');
const Campaign = require('../models/Campaign');
const User = require('../models/User');
const WavesLedgerEntry = require('../models/WavesLedgerEntry');
const CampaignEvent = require('../models/CampaignEvent');
const CampaignAbuseSignal = require('../models/CampaignAbuseSignal');
const Community = require('../models/Community');
const SiteSetting = require('../models/SiteSetting');
const { calculateCommunityAdShare } = require('./communityRevenue');
const wavesService = require('./waves');
const Report = require('../models/Report');
const { deleteFile } = require('./storageCluster');
const logger = require('./logger');

const ADVERTISING_TERMS_VERSION = '2026-10-07-v3';
// Finished campaigns (budget used up, stopped and refunded, or rejected) and their
// delivery data are deleted this many days after they finish.
const AD_RETENTION_DAYS = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const FINISHED_CAMPAIGN_STATUSES = ['completed', 'cancelled', 'rejected'];
const BOT_ACTIVITY_EVENT_THRESHOLD = 20;
const BOT_ACTIVITY_WINDOW_MS = 60 * 1000;
// A community can only be targeted by advertisers while it is public, approved for monetization
// and has ads switched on. The same filter drives the advertiser's community picker, submission
// validation and (via getCommunityCampaigns) delivery, so the three cannot drift apart.
const { selectAds } = require('./adRanker');
const COMMUNITY_AD_ELIGIBLE_FILTER = Object.freeze({
  monetizationStatus: 'approved',
  isMonetized: true,
  isPrivate: false,
  'monetizationSettings.adsEnabled': true,
  'monetizationSettings.adPlacement': { $ne: 'none' }
});
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

function unavailableAdvertisement(message) {
  const error = new Error(message);
  error.code = 'ADVERTISEMENT_UNAVAILABLE';
  return error;
}

// A new advertiser is screened together with their first ad, so a pending profile
// created by an ad submission may already own a (funded, submitted) campaign.
function advertiserCanRunCampaign(advertiser) {
  return Boolean(advertiser)
    && (advertiser.status === 'approved' || (advertiser.status === 'pending' && advertiser.viaCampaign === true));
}

async function registerAdvertiser({
  userId,
  businessName,
  businessDescription = '',
  website = '',
  logoUrl = '',
  bannerUrl = '',
  notes = '',
  isVerified = false,
  acceptedTerms = false,
  viaCampaign = false
}) {
  if (!userId) throw new Error('Advertiser user ID is required.');

  const name = String(businessName || '').trim();
  if (!name) throw new Error('Business name is required.');
  if (!acceptedTerms) throw new Error('You must accept the Advertising Terms to apply.');

  const advertiser = await Advertiser.findOneAndUpdate(
    { user: userId },
    {
      user: userId,
      businessName: name,
      businessDescription: String(businessDescription || '').trim().slice(0, 500),
      website: String(website || '').trim().slice(0, 300),
      logoUrl: String(logoUrl || '').trim().slice(0, 500),
      bannerUrl: String(bannerUrl || '').trim().slice(0, 500),
      notes: String(notes || '').trim().slice(0, 2000),
      isVerified: Boolean(isVerified),
      status: 'pending',
      viaCampaign: Boolean(viaCampaign),
      rejectionReason: '',
      termsAcceptedAt: new Date(),
      termsVersion: ADVERTISING_TERMS_VERSION,
      moderatorReview: { status: 'pending', reason: '', reviewedAt: null, reviewedBy: null },
      reviewedAt: null,
      reviewedBy: null,
      moderationHistory: [{
        status: 'pending',
        reason: viaCampaign ? 'Advertiser details submitted with first advertisement.' : 'Advertiser application submitted.',
        createdAt: new Date(),
        actor: userId
      }],
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
  advertiser.moderationHistory = [
    ...(advertiser.moderationHistory || []).slice(-9),
    {
      status: decision === 'cleared' ? 'moderator-cleared' : 'moderator-flagged',
      reason: note || 'No policy concerns identified.',
      createdAt: new Date(),
      actor: moderatorId
    }
  ];
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

// Normalizes and validates the communities an ad is aimed at. Returns de-duplicated ids of
// communities that currently accept ads; throws if any requested community does not.
async function resolveTargetCommunities(targetCommunities, sitewideFallback) {
  const requested = [...new Set((Array.isArray(targetCommunities) ? targetCommunities : [targetCommunities])
    .filter(Boolean).map(String))];
  if (!requested.length) return [];
  if (sitewideFallback) {
    throw new Error('A campaign targets either specific communities or the Crowdwide-feed fallback, not both.');
  }
  const invalid = () => new Error('Choose only public communities that currently accept approved ads.');
  if (!requested.every((id) => mongoose.isValidObjectId(id))) throw invalid();
  const eligible = await Community.find({ _id: { $in: requested }, ...COMMUNITY_AD_ELIGIBLE_FILTER })
    .select('_id').lean();
  if (eligible.length !== requested.length) throw invalid();
  return eligible.map((community) => community._id);
}

async function createCampaign({
  advertiserId,
  title,
  brandName = '',
  brandLogoUrl = '',
  campaignType = 'other',
  productName = '',
  productPrice = '',
  advertisingRightsConfirmed = false,
  description = '',
  totalBudget,
  dailyBudget = 0,
  startDate,
  endDate,
  targetCommunities = [],
  destinationUrl = '',
  bannerUrl = '',
  sitewideFallback = false,
  smartPlacement = false,
  keywords = [],
  minimumBudget = 25,
  impressionCostWaves = 0.1,
  clickCostWaves = 1,
  isWavesFunded = true,
  status = 'draft',
  notes = '',
  createdByAdmin = false
}) {
  if (!advertiserId) throw new Error('Advertiser ID is required.');

  const advertiser = await Advertiser.findById(advertiserId);
  if (!advertiser) throw new Error('Advertiser not found.');
  if (!advertiserCanRunCampaign(advertiser)) {
    throw new Error('Only approved advertisers can create campaigns.');
  }
  if (advertiser.termsVersion !== ADVERTISING_TERMS_VERSION || !advertiser.termsAcceptedAt) {
    throw new Error('Accept the current Advertising Terms before creating campaigns.');
  }
  if (status !== 'draft') throw new Error('New campaigns must start as drafts and be submitted for review separately.');
  if (!isWavesFunded) throw new Error('Campaign funding is currently supported only with Waves.');
  if (advertisingRightsConfirmed !== true) {
    throw new Error('Confirm that you own or are authorized to advertise this item and its submitted creative.');
  }

  const cleanedTitle = String(title || '').trim();
  if (!cleanedTitle) throw new Error('Campaign title is required.');
  const allowedCampaignTypes = ['product', 'service', 'article', 'event', 'other'];
  if (!allowedCampaignTypes.includes(campaignType)) {
    throw new Error('Choose a valid advertisement type.');
  }
  const cleanedProductName = String(productName || '').trim().slice(0, 120);
  const cleanedProductPrice = String(productPrice || '').trim().slice(0, 60);
  if (campaignType === 'product' && !cleanedProductName) {
    throw new Error('Add the name of the product you are advertising.');
  }

  const budget = normalizePositiveNumber(totalBudget, 'totalBudget');
  const minimum = normalizePositiveNumber(minimumBudget, 'minimumBudget');
  if (budget < minimum) throw new Error(`Campaign budget must be at least ${minimum} Waves.`);
  let cleanedDestinationUrl = '';
  if (destinationUrl) {
    try {
      const parsedUrl = new URL(String(destinationUrl).trim());
      if (!['http:', 'https:'].includes(parsedUrl.protocol) || !parsedUrl.hostname) throw new Error();
      cleanedDestinationUrl = parsedUrl.toString().slice(0, 1000);
    } catch {
      throw new Error('Add a valid http or https destination link for your advertisement.');
    }
  }
  const impressionRate = normalizeNonNegativeNumber(impressionCostWaves, 'impressionCostWaves');
  const clickRate = normalizeNonNegativeNumber(clickCostWaves, 'clickCostWaves');
  const daily = normalizeNonNegativeNumber(dailyBudget, 'dailyBudget');
  if (daily > budget) {
    throw new Error('Daily budget cannot exceed total budget.');
  }

  if (startDate && endDate && new Date(endDate) < new Date(startDate)) {
    throw new Error('End date cannot be before the start date.');
  }
  const cleanedTargets = await resolveTargetCommunities(targetCommunities, sitewideFallback);
  if (smartPlacement && (cleanedTargets.length || sitewideFallback)) {
    throw new Error('Smart placement cannot be combined with specific communities or the Crowdwide-feed fallback.');
  }
  const cleanedKeywords = [...new Set((Array.isArray(keywords) ? keywords : String(keywords || '').split(/[,\n]/))
    .map((word) => String(word).replace(/^#/, '').trim().toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, 12);

  const campaign = await Campaign.create({
    advertiser: advertiserId,
    title: cleanedTitle,
    brandName: String(brandName || '').trim().slice(0, 120),
    brandLogoUrl: String(brandLogoUrl || '').trim().slice(0, 500),
    campaignType,
    productName: cleanedProductName,
    productPrice: cleanedProductPrice,
    rightsConfirmedAt: new Date(),
    description: String(description || '').trim().slice(0, 2000),
    destinationUrl: cleanedDestinationUrl,
    bannerUrl: String(bannerUrl || '').trim().slice(0, 500),
    totalBudget: budget,
    impressionCostWaves: impressionRate,
    clickCostWaves: clickRate,
    dailyBudget: daily,
    remainingBudget: 0,
    startDate: startDate ? new Date(startDate) : null,
    endDate: endDate ? new Date(endDate) : null,
    targetCommunities: cleanedTargets,
    sitewideFallback: Boolean(sitewideFallback),
    smartPlacement: Boolean(smartPlacement),
    keywords: cleanedKeywords,
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

/**
 * One-step ad submission: business details (first time only), ad details and
 * budget are entered once. The budget is escrowed straight away and the ad then
 * goes through a single moderator -> admin review; on approval it goes live.
 */
async function submitAdvertisement({ userId, acceptedTerms = false, business = {}, campaign: input = {} }) {
  if (!userId) throw new Error('User ID is required.');
  if (acceptedTerms !== true) throw new Error('Accept the Advertising Terms before submitting your ad.');

  const existing = await Advertiser.findOne({ user: userId });
  if (existing?.status === 'suspended') {
    throw new Error('Your advertiser account is suspended. Contact support for assistance.');
  }
  if (existing?.status === 'pending') {
    throw new Error(existing.viaCampaign
      ? 'Your ad is still being reviewed. You can submit another once it has been decided.'
      : 'Your advertiser application is still being reviewed.');
  }

  const budget = normalizePositiveNumber(input.totalBudget, 'Campaign budget');
  const wallet = await User.findById(userId).select('wavesBalance wavesSuspendedUntil').lean();
  if (!wallet || Number(wallet.wavesBalance || 0) < budget) {
    throw new Error(`You need at least ${budget} Waves in your wallet to fund this campaign.`);
  }
  if (wallet.wavesSuspendedUntil && new Date(wallet.wavesSuspendedUntil) > new Date()) {
    throw new Error('An active Waves hold prevents campaign funding.');
  }

  // Business details are only collected until the advertiser has been approved once.
  const snapshot = existing ? existing.toObject() : null;
  let advertiser = existing;
  let createdAdvertiser = false;
  let replacedAdvertiser = false;
  if (!existing || existing.status === 'rejected') {
    const name = String(business.businessName || '').trim();
    const description = String(business.businessDescription || '').trim();
    const website = String(business.website || '').trim();
    if (!name || !description) throw new Error('Enter your business name and a short business description.');
    if (website && (!/^https?:\/\//i.test(website) || website.length > 300)) {
      throw new Error('Enter a valid website URL starting with http:// or https://.');
    }
    advertiser = await registerAdvertiser({
      userId,
      businessName: name,
      businessDescription: description,
      website,
      logoUrl: business.logoUrl || '',
      bannerUrl: '',
      notes: business.notes || '',
      acceptedTerms: true,
      viaCampaign: true
    });
    createdAdvertiser = !existing;
    replacedAdvertiser = Boolean(existing);
  } else if (advertiser.termsVersion !== ADVERTISING_TERMS_VERSION || !advertiser.termsAcceptedAt) {
    advertiser.termsAcceptedAt = new Date();
    advertiser.termsVersion = ADVERTISING_TERMS_VERSION;
    await advertiser.save();
  }

  const rollback = async () => {
    try {
      if (createdAdvertiser) await Advertiser.deleteOne({ _id: advertiser._id });
      else if (replacedAdvertiser && snapshot) await Advertiser.replaceOne({ _id: snapshot._id }, snapshot);
    } catch (error) {
      logger.error('Advertiser rollback after failed ad submission failed', { userId, error });
    }
  };

  let campaign;
  try {
    campaign = await createCampaign({ ...input, advertiserId: advertiser._id, status: 'draft' });
  } catch (error) {
    await rollback();
    throw error;
  }
  try {
    campaign = await fundCampaign({ campaignId: campaign._id, actorId: userId });
  } catch (error) {
    await Campaign.deleteOne({ _id: campaign._id });
    await rollback();
    throw error;
  }
  return { advertiser, campaign, firstTime: createdAdvertiser || replacedAdvertiser };
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
  if (!advertiserCanRunCampaign(advertiser)) {
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
    {
      _id: advertiser.user,
      wavesBalance: { $gte: amount },
      $or: [
        { wavesSuspendedUntil: { $exists: false } },
        { wavesSuspendedUntil: null },
        { wavesSuspendedUntil: { $lte: new Date() } }
      ]
    },
    { $inc: { wavesBalance: -amount, wavesTotalSpent: amount } }
  );
  if (!debit.modifiedCount) {
    entry.status = 'reversed';
    entry.reason = 'Campaign funding failed: insufficient Waves balance or active Waves hold.';
    entry.rewardKey = undefined;
    await entry.save();
    throw new Error('Insufficient Waves balance or an active Waves hold prevents campaign funding.');
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
  campaign.moderationHistory = [
    ...(campaign.moderationHistory || []).slice(-9),
    {
      status: decision === 'cleared' ? 'moderator-cleared' : 'moderator-flagged',
      reason: note || 'No policy concerns identified.',
      createdAt: new Date(),
      actor: moderatorId
    }
  ];
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

async function updateCampaignStatus({ campaignId, status, rejectionReason = '', reason = '', actorId = null, activateOnApproval = false }) {
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

  const now = new Date();
  const wasSubmitted = campaign.status === 'submitted';
  // Admin approval of a submitted, funded campaign is the last gate: the ad goes live
  // (it still only serves inside its start/end dates). If its end date already passed
  // while it waited for review, it is closed and the budget refunded instead.
  let effectiveStatus = nextStatus;
  let followUpReason = '';
  if (nextStatus === 'approved' && wasSubmitted && activateOnApproval
    && campaign.isWavesFunded && campaign.fundingStatus === 'funded') {
    if (campaign.endDate && campaign.endDate < now) {
      effectiveStatus = 'completed';
      followUpReason = 'End date passed before approval; unused budget refunded.';
    } else {
      effectiveStatus = 'active';
      followUpReason = 'Went live automatically after admin approval.';
    }
  }

  // A first-time advertiser is screened together with their first ad.
  if (wasSubmitted && ['approved', 'rejected'].includes(nextStatus)) {
    const advertiser = await Advertiser.findById(campaign.advertiser);
    if (advertiser && advertiser.status === 'pending' && advertiser.viaCampaign) {
      if (nextStatus === 'approved') {
        advertiser.status = 'approved';
        advertiser.approvedAt = now;
        if (!advertiser.isVerified) {
          advertiser.isVerified = true;
          advertiser.verifiedAt = now;
        }
        advertiser.rejectionReason = '';
        advertiser.moderatorReview = {
          status: 'cleared',
          reason: campaign.moderatorReview?.reason || 'Cleared with first advertisement.',
          reviewedAt: campaign.moderatorReview?.reviewedAt || now,
          reviewedBy: campaign.moderatorReview?.reviewedBy || null
        };
      } else {
        advertiser.status = 'rejected';
        advertiser.rejectionReason = String(rejectionReason || '').trim().slice(0, 500);
      }
      advertiser.reviewedAt = now;
      advertiser.reviewedBy = actorId || null;
      advertiser.moderationHistory = [
        ...(advertiser.moderationHistory || []).slice(-9),
        {
          status: advertiser.status,
          reason: nextStatus === 'approved' ? 'Approved together with first advertisement.' : advertiser.rejectionReason,
          createdAt: now,
          actor: actorId || null
        }
      ];
      await advertiser.save();
    }
  }

  campaign.status = effectiveStatus;
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
  if (FINISHED_CAMPAIGN_STATUSES.includes(effectiveStatus)) campaign.finishedAt = now;

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
    },
    ...(effectiveStatus !== nextStatus
      ? [{ status: effectiveStatus, reason: followUpReason, createdAt: new Date(), actor: actorId || null }]
      : [])
  ];

  await campaign.save();
  if (['rejected', 'cancelled', 'completed'].includes(effectiveStatus) && campaign.remainingBudget > 0 && campaign.fundingStatus === 'funded') {
    return refundCampaignBudget({
      campaignId: campaign._id,
      reason: effectiveStatus === 'rejected' ? `Campaign rejected: ${campaign.rejectionReason || 'moderation decision'}` : `Unused budget returned when campaign ${effectiveStatus}.`,
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

// Campaigns that may appear on this community's page, best first.
//  - Monetized communities with ads switched on: campaigns that target them, plus smart ones.
//  - Other public communities: smart-placement campaigns only (no revenue share).
// Private communities and communities that opted out never show ads.
async function getCommunityCampaigns(communityId, now = new Date(), { seen = new Map(), limit = 3, rng } = {}) {
  if (!communityId) return [];
  const community = await Community.findById(communityId).lean();
  if (!community || community.isPrivate) return [];
  const monetized = community.isMonetized && community.monetizationStatus === 'approved';
  if (monetized && (!community.monetizationSettings?.adsEnabled || community.monetizationSettings?.adPlacement === 'none')) return [];
  const campaigns = await Campaign.find({
    status: 'active',
    fundingStatus: 'funded',
    remainingBudget: { $gt: 0 },
    $or: [...(monetized ? [{ targetCommunities: communityId }] : []), { smartPlacement: true, targetCommunities: { $size: 0 } }],
    $and: [
      { $or: [{ startDate: null }, { startDate: { $lte: now } }] },
      { $or: [{ endDate: null }, { endDate: { $gte: now } }] }
    ]
  }).sort({ createdAt: 1 }).limit(60)
    .populate('advertiser', 'businessName website logoUrl status')
    .lean();
  const approved = campaigns.filter((campaign) => campaign.advertiser?.status === 'approved');
  return selectAds(approved, { context: community, seen, limit, now: now.getTime(), ...(rng ? { rng } : {}) });
}

async function hasMonetizedPublicCommunity() {
  return Boolean(await Community.exists({
    isPrivate: false,
    isMonetized: true,
    monetizationStatus: 'approved'
  }));
}

async function getSitewideFeedCampaigns(now = new Date()) {
  if (await hasMonetizedPublicCommunity()) return [];
  const campaigns = await Campaign.find({
    status: 'active',
    fundingStatus: 'funded',
    remainingBudget: { $gt: 0 },
    sitewideFallback: true,
    targetCommunities: { $size: 0 },
    $and: [
      { $or: [{ startDate: null }, { startDate: { $lte: now } }] },
      { $or: [{ endDate: null }, { endDate: { $gte: now } }] }
    ]
  }).sort({ createdAt: 1 }).limit(30)
    .populate('advertiser', 'businessName website logoUrl status')
    .lean();
  return campaigns.filter((campaign) => campaign.advertiser?.status === 'approved');
}

async function recordCampaignEvent({ campaignId, communityId, deliveryContext = 'community', viewerId, eventType, eventToken }) {
  if (!['impression', 'click'].includes(eventType)) throw new Error('Invalid advertisement event type.');
  if (!['community', 'sitewide'].includes(deliveryContext)) throw new Error('Invalid advertisement delivery context.');
  if (deliveryContext === 'community' && !communityId) throw new Error('Community ID is required.');
  if (deliveryContext === 'sitewide' && communityId) throw new Error('Sitewide events cannot include a community ID.');
  if (!/^[a-f\d-]{36}$/i.test(String(eventToken || ''))) throw new Error('Invalid advertisement event token.');
  if (!viewerId) throw new Error('Viewer ID is required.');

  const [community, campaign] = await Promise.all([
    deliveryContext === 'community' ? Community.findById(communityId).lean() : Promise.resolve(null),
    Campaign.findById(campaignId).populate('advertiser', 'businessName website status user').lean()
  ]);
  const isSmartCampaign = Boolean(campaign?.smartPlacement) && !(campaign.targetCommunities || []).length;
  const communityMonetized = Boolean(community?.isMonetized && community.monetizationStatus === 'approved');
  if (deliveryContext === 'community') {
    // Monetized communities need ads switched on; other public communities only carry smart-placement ads.
    const allowed = community && !community.isPrivate && (communityMonetized
      ? community.monetizationSettings?.adsEnabled && community.monetizationSettings?.adPlacement !== 'none'
      : isSmartCampaign);
    if (!allowed) throw unavailableAdvertisement('Advertisements are not enabled for this community.');
  }
  // A feed card may already be open when community monetization begins; let
  // its click finish, but never record a new sitewide impression afterward.
  if (deliveryContext === 'sitewide'
    && ((eventType === 'impression' && await hasMonetizedPublicCommunity())
      || !campaign?.sitewideFallback
      || (campaign.targetCommunities || []).length)) {
    throw unavailableAdvertisement('Crowdwide-feed advertisements are unavailable.');
  }
  const now = new Date();
  const spend = Number(eventType === 'impression'
    ? campaign?.impressionCostWaves ?? 0.1
    : campaign?.clickCostWaves ?? 1);
  if (!Number.isFinite(spend) || spend < 0) {
    throw new Error('Campaign advertising prices are invalid.');
  }
  const isEligibleRenderedClick = (candidate) => eventType === 'click'
    && candidate
    && candidate.fundingStatus === 'funded'
    && (candidate.status === 'active'
      || (candidate.status === 'completed' && Number(candidate.remainingBudget || 0) <= 0))
    && candidate.advertiser?.status === 'approved'
    && (!candidate.startDate || candidate.startDate <= now)
    && (!candidate.endDate || candidate.endDate >= now)
    && (deliveryContext === 'sitewide'
      ? candidate.sitewideFallback && !(candidate.targetCommunities || []).length
      : ((candidate.targetCommunities || []).some((id) => String(id) === String(communityId))
        || (candidate.smartPlacement && !(candidate.targetCommunities || []).length)));
  const canCompleteRenderedClick = (candidate) => isEligibleRenderedClick(candidate)
    && (candidate.status === 'completed' || Number(candidate.remainingBudget || 0) < spend);
  const resolveDestinationUrl = (candidate) => {
    try {
      const destination = new URL(candidate.destinationUrl || candidate.advertiser.website);
      if (!['http:', 'https:'].includes(destination.protocol)) throw unavailableAdvertisement('Unsupported destination.');
      return destination.toString();
    } catch {
      throw unavailableAdvertisement('This advertiser has no valid destination link.');
    }
  };
  const completeRenderedClickWithoutCharge = canCompleteRenderedClick(campaign);
  if (!campaign || campaign.status !== 'active' || campaign.fundingStatus !== 'funded'
    || (Number(campaign.remainingBudget || 0) <= 0 && !completeRenderedClickWithoutCharge)
    || (deliveryContext === 'community' && !isSmartCampaign && !(campaign.targetCommunities || []).some((id) => String(id) === String(communityId)))
    || campaign.advertiser?.status !== 'approved'
    || (campaign.startDate && campaign.startDate > now)
    || (campaign.endDate && campaign.endDate < now)) {
    if (!completeRenderedClickWithoutCharge) {
      throw unavailableAdvertisement('This advertisement is no longer available.');
    }
  }

  let destinationUrl = '';
  if (eventType === 'click') {
    destinationUrl = resolveDestinationUrl(campaign);
  }

  // A rendered ad stays navigable if its impression or another event used the remaining budget.
  if (completeRenderedClickWithoutCharge) {
    return { recorded: false, destinationUrl, wavesCharged: 0 };
  }
  const ownerId = community?.owner;
  const viewerIsOwner = ownerId && String(ownerId) === String(viewerId);
  const viewerIsAdvertiser = campaign.advertiser?.user && String(campaign.advertiser.user) === String(viewerId);
  const requestedRevenueSharePercent = communityMonetized ? Number(community?.monetizationSettings?.revenueSharePercent ?? 0) : 0;
  const communityShareEligible = deliveryContext === 'community' && ownerId && !viewerIsOwner && !viewerIsAdvertiser;
  const revenueSharePercent = communityShareEligible ? requestedRevenueSharePercent : 0;
  const ownerShare = communityShareEligible
    ? calculateCommunityAdShare({ campaignSpendWaves: spend, communityOwnerSharePercent: revenueSharePercent })
    : calculateCommunityAdShare({ campaignSpendWaves: spend, communityOwnerSharePercent: 0 });
  const communityOwnerShareWaves = ownerShare?.communityOwnerShareWaves || 0;
  const viewerDayKey = `${campaign._id}:${community?._id || 'sitewide'}:${viewerId}:${eventType}:${now.toISOString().slice(0, 10)}`;

  const settleCommunityShare = async (event) => {
    if (!event || event.communityShareStatus !== 'pending' || !(event.communityOwnerShareWaves > 0)) return false;
    const result = await wavesService.creditCommunityAdShare({
      userId: event.communityOwner,
      amount: event.communityOwnerShareWaves,
      communityId: event.community,
      eventId: event._id,
      viewerId: event.viewer,
      revenueSharePercent: event.communityOwnerSharePercent
    });
    if (result.duplicate || result.amount > 0) {
      await CampaignEvent.updateOne(
        { _id: event._id, communityShareStatus: 'pending' },
        { $set: { communityShareStatus: 'posted' } }
      );
      return true;
    }
    return false;
  };

  let createdEvent;
  try {
    createdEvent = await CampaignEvent.create({
      campaign: campaign._id,
      community: community?._id || null,
      deliveryContext,
      viewer: viewerId,
      eventType,
      eventToken,
      viewerDayKey,
      wavesCharged: spend,
      communityOwner: communityOwnerShareWaves > 0 ? ownerId : null,
      communityOwnerSharePercent: revenueSharePercent,
      communityOwnerShareWaves,
      crowdwideShareWaves: ownerShare.crowdwideShareWaves,
      communityShareStatus: communityOwnerShareWaves > 0 ? 'pending' : 'not-eligible'
    });
  } catch (error) {
    if (error?.code === 11000) {
      const signalKey = `${campaign._id}:${deliveryContext}:${community?._id || 'crowdwide'}:${viewerId}:${eventType}`;
      await CampaignAbuseSignal.findOneAndUpdate(
        { signalKey },
        {
          $setOnInsert: {
            signalKey,
            campaign: campaign._id,
            community: community?._id || null,
            viewer: viewerId,
            eventType,
            reason: 'Repeated ad event rejected by per-viewer daily limit.',
            firstSeenAt: now
          },
          $set: { lastSeenAt: now, status: 'open', reviewedAt: null, reviewedBy: null, reviewNote: '' },
          $inc: { attempts: 1 }
        },
        { upsert: true, new: true }
      );
      const existingEvent = await CampaignEvent.findOne({ viewerDayKey }).lean();
      await settleCommunityShare(existingEvent);
      return { recorded: false, destinationUrl };
    }
    throw error;
  }

  const impressionIncrement = eventType === 'impression' ? 1 : 0;
  const clickIncrement = eventType === 'click' ? 1 : 0;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const currentDailySpend = {
    $cond: [
      { $gte: [{ $ifNull: ['$dailyBudgetDate', new Date(0)] }, today] },
      { $ifNull: ['$dailyBudgetSpent', 0] },
      0
    ]
  };
  const dailyBudgetAllowsSpend = {
    $or: [
      { $lte: [{ $ifNull: ['$dailyBudget', 0] }, 0] },
      { $lte: [{ $add: [currentDailySpend, spend] }, '$dailyBudget'] }
    ]
  };
  let updated;
  try {
    updated = await Campaign.findOneAndUpdate(
      {
        _id: campaign._id,
        status: 'active',
        fundingStatus: 'funded',
        remainingBudget: { $gte: spend },
        ...(deliveryContext === 'community'
          ? { targetCommunities: community._id }
          : { sitewideFallback: true, targetCommunities: { $size: 0 } }),
        $expr: dailyBudgetAllowsSpend
      },
      [
        { $set: {
          impressions: { $add: [{ $ifNull: ['$impressions', 0] }, impressionIncrement] },
          clicks: { $add: [{ $ifNull: ['$clicks', 0] }, clickIncrement] },
          remainingBudget: { $round: [{ $subtract: ['$remainingBudget', spend] }, 6] },
          wavesSpent: { $round: [{ $add: [{ $ifNull: ['$wavesSpent', 0] }, spend] }, 6] },
          dailyBudgetSpent: { $round: [{ $add: [currentDailySpend, spend] }, 6] },
          dailyBudgetDate: today
        } },
        { $set: {
          ctr: {
            $cond: [
              { $gt: ['$impressions', 0] },
              { $round: [{ $multiply: [{ $divide: ['$clicks', '$impressions'] }, 100] }, 4] },
              0
            ]
          },
          status: { $cond: [{ $lte: ['$remainingBudget', 0] }, 'completed', '$status'] },
          finishedAt: { $cond: [{ $lte: ['$remainingBudget', 0] }, '$$NOW', { $ifNull: ['$finishedAt', null] }] }
        } }
      ],
      { new: true }
    );
  } catch (error) {
    await CampaignEvent.deleteOne({ campaign: campaign._id, community: community?._id || null, deliveryContext, eventType, eventToken });
    throw error;
  }
  if (!updated) {
    await CampaignEvent.deleteOne({ campaign: campaign._id, community: community?._id || null, deliveryContext, eventType, eventToken });
    if (eventType === 'click') {
      const latestCampaign = await Campaign.findById(campaign._id)
        .populate('advertiser', 'businessName website status user')
        .lean();
      if (isEligibleRenderedClick(latestCampaign)) {
        return { recorded: false, destinationUrl: resolveDestinationUrl(latestCampaign), wavesCharged: 0 };
      }
    }
    throw unavailableAdvertisement('This advertisement is no longer available.');
  }
  await settleCommunityShare(createdEvent);
  let botActivitySignal = false;
  try {
    const recentEventCount = await CampaignEvent.countDocuments({
      viewer: viewerId,
      createdAt: { $gte: new Date(now.getTime() - BOT_ACTIVITY_WINDOW_MS) }
    });
    if (recentEventCount >= BOT_ACTIVITY_EVENT_THRESHOLD) {
      const minuteBucket = Math.floor(now.getTime() / BOT_ACTIVITY_WINDOW_MS);
      await CampaignAbuseSignal.findOneAndUpdate(
        { signalKey: `bot-activity:${viewerId}:${minuteBucket}` },
        {
          $setOnInsert: {
            signalKey: `bot-activity:${viewerId}:${minuteBucket}`,
            campaign: campaign._id,
            community: community?._id || null,
            viewer: viewerId,
            eventType: 'bot-activity',
            reason: `High-volume ad activity: ${recentEventCount} unique events within one minute. This is a review signal, not proof of automation.`,
            firstSeenAt: now
          },
          $set: { lastSeenAt: now, status: 'open', reviewedAt: null, reviewedBy: null, reviewNote: '' },
          $max: { attempts: recentEventCount }
        },
        { upsert: true, new: true }
      );
      botActivitySignal = true;
    }
  } catch (error) {
    logger.warn('High-volume ad activity could not be checked', { campaignId: campaign._id, viewerId, error });
  }
  return { recorded: true, destinationUrl, wavesCharged: spend, botActivitySignal };
}

async function getCampaignAnalytics(campaignIds, now = new Date()) {
  const ids = Array.isArray(campaignIds) ? campaignIds : [];
  if (!ids.length) return { byCommunity: [], daily: [] };

  const match = { campaign: { $in: ids } };
  const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const dailyMatch = { ...match, createdAt: { $gte: since, $lte: now } };
  const impressionCount = { $sum: { $cond: [{ $eq: ['$eventType', 'impression'] }, 1, 0] } };
  const clickCount = { $sum: { $cond: [{ $eq: ['$eventType', 'click'] }, 1, 0] } };
  const [communityRows, dailyRows] = await Promise.all([
    CampaignEvent.aggregate([
      { $match: match },
      { $group: { _id: { campaign: '$campaign', community: '$community' }, impressions: impressionCount, clicks: clickCount } }
    ]),
    CampaignEvent.aggregate([
      { $match: dailyMatch },
      { $group: {
        _id: { campaign: '$campaign', date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } } },
        impressions: impressionCount,
        clicks: clickCount
      } },
      { $sort: { '_id.date': 1 } }
    ])
  ]);
  const communityIds = [...new Set(communityRows.map((row) => row._id.community).filter(Boolean).map(String))];
  const communities = communityIds.length
    ? await Community.find({ _id: { $in: communityIds } }).select('name').lean()
    : [];
  const communityNames = new Map(communities.map((community) => [String(community._id), community.name]));
  const addCtr = (row) => ({
    impressions: Number(row.impressions || 0),
    clicks: Number(row.clicks || 0),
    ctr: calculateCtr(row)
  });

  return {
    byCommunity: communityRows.map((row) => ({
      campaignId: String(row._id.campaign),
      communityName: row._id.community ? communityNames.get(String(row._id.community)) || 'Community' : 'Crowdwide feed',
      ...addCtr(row)
    })),
    daily: dailyRows.map((row) => ({
      campaignId: String(row._id.campaign),
      date: row._id.date,
      ...addCtr(row)
    }))
  };
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
    campaign.finishedAt = new Date();
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

/**
 * Campaigns whose scheduled end date has passed are closed here (status
 * "completed") and any unused budget is refunded, so they start their
 * retention countdown like every other finished campaign.
 */
async function expireEndedCampaigns(now = new Date()) {
  const ended = await Campaign.find({
    status: { $in: ['active', 'approved', 'paused'] },
    endDate: { $ne: null, $lt: now }
  }).select('_id').limit(500).lean();
  let expired = 0;
  let failed = 0;
  for (const { _id } of ended) {
    try {
      await updateCampaignStatus({ campaignId: _id, status: 'completed', reason: 'Scheduled end date reached.' });
      expired += 1;
    } catch (error) {
      failed += 1;
      logger.warn('Ended campaign could not be closed', { campaignId: _id, error });
    }
  }
  return { expired, failed };
}

function campaignBannerFile(bannerUrl) {
  const match = /^\/media\/(\d+)\/([a-f\d]{24})$/i.exec(String(bannerUrl || ''));
  return match ? { cluster: Number(match[1]), id: match[2] } : null;
}

/**
 * Deletes finished campaigns (budget used up, cancelled/refunded, rejected, or
 * paused with nothing left) once they have been finished for AD_RETENTION_DAYS,
 * together with their delivery events, abuse signals, ad reports and banner file.
 * Never deletes a campaign that still holds an unrefunded budget or has an unpaid
 * community-owner share. Waves ledger entries are kept: they are the wallet history.
 */
async function deleteFinishedCampaigns({ now = new Date(), retentionDays = AD_RETENTION_DAYS } = {}) {
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  const candidates = await Campaign.find({
    remainingBudget: { $lte: 0 },
    $or: [
      {
        status: { $in: FINISHED_CAMPAIGN_STATUSES },
        $or: [
          { finishedAt: { $lte: cutoff } },
          { finishedAt: null, updatedAt: { $lte: cutoff } }
        ]
      },
      { status: 'paused', updatedAt: { $lte: cutoff } }
    ]
  }).select('_id bannerUrl').limit(500).lean();
  if (!candidates.length) return { campaigns: 0, events: 0, abuseSignals: 0, reports: 0, bannerFiles: 0, skipped: 0 };

  const candidateIds = candidates.map((campaign) => campaign._id);
  const unpaidShares = new Set((await CampaignEvent.distinct('campaign', {
    campaign: { $in: candidateIds },
    communityShareStatus: 'pending'
  })).map(String));
  const doomed = candidates.filter((campaign) => !unpaidShares.has(String(campaign._id)));
  const ids = doomed.map((campaign) => campaign._id);
  const skipped = candidates.length - doomed.length;
  if (!ids.length) return { campaigns: 0, events: 0, abuseSignals: 0, reports: 0, bannerFiles: 0, skipped };

  const [events, signals, reports] = await Promise.all([
    CampaignEvent.deleteMany({ campaign: { $in: ids } }),
    CampaignAbuseSignal.deleteMany({ campaign: { $in: ids } }),
    Report.deleteMany({ targetType: 'advertisement', target: { $in: ids } })
  ]);
  let bannerFiles = 0;
  for (const campaign of doomed) {
    const file = campaignBannerFile(campaign.bannerUrl);
    if (!file) continue;
    await deleteFile(file.cluster, file.id);
    bannerFiles += 1;
  }
  const removed = await Campaign.deleteMany({ _id: { $in: ids } });
  return {
    campaigns: removed.deletedCount,
    events: events.deletedCount,
    abuseSignals: signals.deletedCount,
    reports: reports.deletedCount,
    bannerFiles,
    skipped
  };
}

/** Daily ad housekeeping: close ended campaigns, then delete long-finished ones. */
async function cleanupFinishedCampaigns({ now = new Date(), retentionDays = AD_RETENTION_DAYS } = {}) {
  const closed = await expireEndedCampaigns(now);
  const deleted = await deleteFinishedCampaigns({ now, retentionDays });
  return { closedEnded: closed.expired, closeFailed: closed.failed, ...deleted };
}

module.exports = {
  AD_RETENTION_DAYS,
  COMMUNITY_AD_ELIGIBLE_FILTER,
  FINISHED_CAMPAIGN_STATUSES,
  cleanupFinishedCampaigns,
  deleteFinishedCampaigns,
  expireEndedCampaigns,
  submitAdvertisement,
  ADVERTISING_POLICY_CATEGORIES,
  ADVERTISING_TERMS_VERSION,
  calculateCtr,
  getCampaignAnalytics,
  getCommunityCampaigns,
  getSitewideFeedCampaigns,
  hasMonetizedPublicCommunity,
  createCampaign,
  fundCampaign,
  submitCampaign,
  getCampaignSummary,
  recordCampaignPerformance,
  recordCampaignEvent,
  refundCampaignBudget,
  registerAdvertiser,
  reviewAdvertiserAsModerator,
  reviewCampaignAsModerator,
  spendCampaignBudget,
  updateAdvertiserStatus,
  updateCampaignStatus
};
