const Advertiser = require('../models/Advertiser');
const Campaign = require('../models/Campaign');
const Community = require('../models/Community');
const logger = require('../services/logger');
const {
  createCampaign,
  registerAdvertiser,
  submitCampaign,
  updateCampaignStatus
} = require('../services/advertising');

function flash(req, type, message) {
  req.session.flash = { type, message };
}

async function getOwnedAdvertiser(userId) {
  return Advertiser.findOne({ user: userId });
}

exports.dashboard = async (req, res) => {
  const advertiser = await getOwnedAdvertiser(req.session.user.id);
  const [campaigns, communities] = await Promise.all([
    advertiser
      ? Campaign.find({ advertiser: advertiser._id }).sort({ createdAt: -1 }).limit(100).lean()
      : [],
    Community.find({ monetizationStatus: 'approved', isMonetized: true, isPrivate: false, 'monetizationSettings.adsEnabled': true })
      .select('name slug')
      .sort({ name: 1 })
      .limit(300)
      .lean()
  ]);
  const totals = campaigns.reduce((summary, campaign) => {
    summary.impressions += Number(campaign.impressions || 0);
    summary.clicks += Number(campaign.clicks || 0);
    summary.remainingBudget += Number(campaign.remainingBudget || 0);
    summary.wavesSpent += Number(campaign.wavesSpent || 0);
    return summary;
  }, { impressions: 0, clicks: 0, remainingBudget: 0, wavesSpent: 0 });
  totals.ctr = totals.impressions ? Number((totals.clicks / totals.impressions * 100).toFixed(4)) : 0;

  res.render('pages/advertising-dashboard', {
    title: 'Advertising dashboard',
    pagePath: '/advertising',
    noIndex: true,
    advertiser,
    campaigns,
    communities,
    totals
  });
};

exports.apply = async (req, res) => {
  const name = String(req.body.businessName || '').trim();
  const website = String(req.body.website || '').trim();
  if (!name) {
    flash(req, 'error', 'Enter your business or organization name.');
    return res.redirect('/advertising');
  }
  if (website && (!/^https?:\/\//i.test(website) || website.length > 300)) {
    flash(req, 'error', 'Enter a valid website URL starting with http:// or https://.');
    return res.redirect('/advertising');
  }

  try {
    const existing = await getOwnedAdvertiser(req.session.user.id);
    if (existing && ['pending', 'approved', 'suspended'].includes(existing.status)) {
      flash(req, 'error', 'Your advertiser profile already has an active review or approval.');
      return res.redirect('/advertising');
    }
    await registerAdvertiser({
      userId: req.session.user.id,
      businessName: name,
      website,
      notes: String(req.body.notes || '').trim().slice(0, 2000)
    });
    flash(req, 'success', 'Advertiser application submitted for admin review.');
  } catch (error) {
    logger.error('Advertiser application failed', error);
    flash(req, 'error', 'The advertiser application could not be saved. Please try again.');
  }
  return res.redirect('/advertising');
};

exports.createCampaign = async (req, res) => {
  const advertiser = await getOwnedAdvertiser(req.session.user.id);
  if (!advertiser || advertiser.status !== 'approved') {
    flash(req, 'error', 'An approved advertiser profile is required to create a campaign.');
    return res.redirect('/advertising');
  }

  const targetCommunities = Array.isArray(req.body.targetCommunities)
    ? req.body.targetCommunities
    : [req.body.targetCommunities].filter(Boolean);
  try {
    const eligibleTargets = await Community.find({
      _id: { $in: targetCommunities },
      monetizationStatus: 'approved',
      isMonetized: true,
      isPrivate: false,
      'monetizationSettings.adsEnabled': true
    }).select('_id').lean();
    if (eligibleTargets.length !== new Set(targetCommunities.map(String)).size) {
      flash(req, 'error', 'Choose only public communities that currently accept approved ads.');
      return res.redirect('/advertising');
    }
    await createCampaign({
      advertiserId: advertiser._id,
      title: req.body.title,
      description: req.body.description,
      totalBudget: req.body.totalBudget,
      dailyBudget: req.body.dailyBudget,
      startDate: req.body.startDate || undefined,
      endDate: req.body.endDate || undefined,
      targetCommunities,
      status: 'draft'
    });
    flash(req, 'success', 'Campaign draft created.');
  } catch (error) {
    logger.warn('Campaign draft could not be created', { userId: req.session.user.id, error });
    flash(req, 'error', error.message || 'The campaign draft could not be created.');
  }
  return res.redirect('/advertising');
};

exports.campaignAction = async (req, res) => {
  const advertiser = await getOwnedAdvertiser(req.session.user.id);
  const campaign = advertiser
    ? await Campaign.findOne({ _id: req.params.id, advertiser: advertiser._id })
    : null;
  if (!campaign) {
    flash(req, 'error', 'Campaign not found.');
    return res.redirect('/advertising');
  }

  const action = String(req.body.action || '');
  try {
    if (action === 'submit') {
      if (campaign.status !== 'draft') throw new Error('Only draft campaigns can be submitted.');
      await submitCampaign({ campaignId: campaign._id, actorId: req.session.user.id });
      flash(req, 'success', 'Campaign budget funded; campaign submitted for admin review.');
    } else if (action === 'activate') {
      if (campaign.status !== 'approved' && campaign.status !== 'paused') {
        throw new Error('Only approved or paused campaigns can be activated.');
      }
      await updateCampaignStatus({ campaignId: campaign._id, status: 'active', actorId: req.session.user.id });
      flash(req, 'success', 'Campaign activated.');
    } else if (action === 'pause') {
      if (campaign.status !== 'active' && campaign.status !== 'approved') {
        throw new Error('Only approved or active campaigns can be paused.');
      }
      await updateCampaignStatus({ campaignId: campaign._id, status: 'paused', actorId: req.session.user.id });
      flash(req, 'success', 'Campaign paused.');
    } else if (action === 'cancel') {
      if (!['draft', 'submitted', 'approved', 'active', 'paused'].includes(campaign.status)) {
        throw new Error('This campaign cannot be cancelled in its current state.');
      }
      await updateCampaignStatus({ campaignId: campaign._id, status: 'cancelled', actorId: req.session.user.id });
      flash(req, 'success', 'Campaign cancelled. Any unused funded budget was returned to your Waves wallet.');
    } else {
      throw new Error('Choose a valid campaign action.');
    }
  } catch (error) {
    logger.warn('Advertiser campaign action failed', { campaignId: campaign._id, userId: req.session.user.id, error });
    flash(req, 'error', error.message || 'The campaign action could not be completed.');
  }
  return res.redirect('/advertising');
};
