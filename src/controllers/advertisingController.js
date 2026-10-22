const Advertiser = require('../models/Advertiser');
const Campaign = require('../models/Campaign');
const Community = require('../models/Community');
const Report = require('../models/Report');
const Appeal = require('../models/Appeal');
const SiteSetting = require('../models/SiteSetting');
const { uploadBuffer, mediaUrl } = require('../services/storageCluster');
const logger = require('../services/logger');
const {
  ADVERTISING_TERMS_VERSION,
  AD_RETENTION_DAYS,
  submitAdvertisement,
  submitCampaign,
  updateCampaignStatus,
  recordCampaignEvent,
  getCampaignAnalytics,
  hasMonetizedPublicCommunity,
  COMMUNITY_AD_ELIGIBLE_FILTER
} = require('../services/advertising');

function flash(req, type, message) {
  req.session.flash = { type, message };
}

async function getOwnedAdvertiser(userId) {
  return Advertiser.findOne({ user: userId });
}

const { describeDelivery } = require('../utils/adDelivery');

exports.dashboard = async (req, res) => {
  const advertiser = await Advertiser.findOne({ user: req.session.user.id })
    .populate('moderationHistory.actor', 'name role');
  const [campaigns, communities, advertiserAppeal, siteSettings, sitewideFallbackAvailable] = await Promise.all([
    advertiser
      ? Campaign.find({ advertiser: advertiser._id })
        .sort({ createdAt: -1 })
        .limit(100)
        .populate('moderationHistory.actor', 'name role')
        .populate('targetCommunities', 'name slug isPrivate isMonetized monetizationStatus monetizationSettings')
        .lean()
      : [],
    Community.find(COMMUNITY_AD_ELIGIBLE_FILTER)
      .select('name slug')
      .sort({ name: 1 })
      .limit(300)
      .lean(),
    advertiser
      ? Appeal.findOne({ user: req.session.user.id, advertiser: advertiser._id, actionType: 'advertiser', status: 'pending' }).lean()
      : null,
    SiteSetting.getSingleton(),
    Promise.resolve(true)
  ]);
  const campaignAnalytics = await getCampaignAnalytics(campaigns.map((campaign) => campaign._id));
  const deliveryByCampaign = Object.fromEntries(campaigns.map((campaign) => [String(campaign._id), describeDelivery(campaign, { advertiserStatus: advertiser?.status })]));
  const totals = campaigns.reduce((summary, campaign) => {
    summary.impressions += Number(campaign.impressions || 0);
    summary.clicks += Number(campaign.clicks || 0);
    summary.remainingBudget += Number(campaign.remainingBudget || 0);
    summary.wavesSpent += Number(campaign.wavesSpent || 0);
    return summary;
  }, { impressions: 0, clicks: 0, remainingBudget: 0, wavesSpent: 0 });
  totals.ctr = totals.impressions ? Number((totals.clicks / totals.impressions * 100).toFixed(4)) : 0;

  // /advertising?community=<slug> (linked from a community page) pre-selects that community.
  const preselectedSlug = String(req.query.community || '').trim().toLowerCase().slice(0, 120);
  const preselectedCommunityId = preselectedSlug
    ? String(communities.find((community) => String(community.slug || '').toLowerCase() === preselectedSlug)?._id || '')
    : '';

  res.render('pages/advertising-dashboard', {
    title: 'Advertising dashboard',
    preselectedCommunityId,
    pagePath: '/advertising',
    noIndex: true,
    advertiser,
    campaigns,
    communities,
    sitewideFallbackAvailable,
    advertisingMinimumCampaignBudget: Number(siteSettings.advertisingMinimumCampaignBudget ?? 25),
    campaignAnalytics,
    deliveryByCampaign,
    totals,
    advertisingTermsVersion: ADVERTISING_TERMS_VERSION,
    adRetentionDays: AD_RETENTION_DAYS,
    advertisingTermsAccepted: advertiser?.termsVersion === ADVERTISING_TERMS_VERSION && Boolean(advertiser.termsAcceptedAt),
    advertiserAppeal
  });
};

exports.submitAdvertiserAppeal = async (req, res) => {
  const message = String(req.body.message || '').trim().slice(0, 1000);
  if (!message) {
    flash(req, 'error', 'Explain why you are appealing the advertiser decision.');
    return res.redirect('/advertising');
  }

  const advertiser = await getOwnedAdvertiser(req.session.user.id);
  if (!advertiser || !['rejected', 'suspended'].includes(advertiser.status)) {
    flash(req, 'error', 'Only rejected or suspended advertiser accounts can be appealed.');
    return res.redirect('/advertising');
  }
  try {
    const lastModeration = [...(advertiser.moderationHistory || [])].reverse()
      .find((item) => item.status === advertiser.status);
    await Appeal.create({
      user: req.session.user.id,
      advertiser: advertiser._id,
      actionType: 'advertiser',
      reasonSnapshot: advertiser.rejectionReason || lastModeration?.reason || '',
      message
    });
    flash(req, 'success', 'Your advertiser appeal has been submitted for admin review.');
  } catch (error) {
    if (error?.code === 11000) {
      flash(req, 'error', 'You already have a pending advertiser appeal.');
      return res.redirect('/advertising');
    }
    logger.error('Advertiser appeal submission failed', error);
    flash(req, 'error', 'Your advertiser appeal could not be submitted. Please try again.');
  }
  return res.redirect('/advertising');
};

// One form for everything: business details (first time only), ad details, budget and
// terms. The budget is escrowed on submit; a moderator then an admin review the ad once
// and, when approved, it goes live. Nothing else is needed from the advertiser.
exports.submitAd = async (req, res) => {
  const advertiser = await getOwnedAdvertiser(req.session.user.id);
  const needsBusinessDetails = !advertiser || advertiser.status === 'rejected';
  if (req.body.acceptAdvertisingTerms !== 'on') {
    flash(req, 'error', 'Accept the Advertising Terms before submitting your ad.');
    return res.redirect('/advertising');
  }
  if (req.body.confirmAdvertisingRights !== 'on') {
    flash(req, 'error', 'Confirm that you own or are authorized to advertise the item and its submitted creative.');
    return res.redirect('/advertising');
  }

  const targetCommunities = Array.isArray(req.body.targetCommunities)
    ? req.body.targetCommunities
    : [req.body.targetCommunities].filter(Boolean);
  const sitewideFallback = req.body.sitewideFallback === 'on';
  const smartPlacement = req.body.smartPlacement === 'on';
  try {
    const [eligibleTargets, settings, hasMonetizedCommunity] = await Promise.all([
      Community.find({ _id: { $in: targetCommunities }, ...COMMUNITY_AD_ELIGIBLE_FILTER }).select('_id').lean(),
      SiteSetting.getSingleton(),
      hasMonetizedPublicCommunity()
    ]);
    if (eligibleTargets.length !== new Set(targetCommunities.map(String)).size) {
      flash(req, 'error', 'Choose only public communities that currently accept approved ads.');
      return res.redirect('/advertising');
    }
    if (sitewideFallback && targetCommunities.length) {
      flash(req, 'error', 'The Crowdwide-feed option cannot be combined with chosen communities.');
      return res.redirect('/advertising');
    }
    if (smartPlacement && (targetCommunities.length || sitewideFallback)) {
      flash(req, 'error', 'Smart placement cannot be combined with chosen communities or the Crowdwide-feed fallback.');
      return res.redirect('/advertising');
    }
    if (!targetCommunities.length && !sitewideFallback && !smartPlacement) {
      flash(req, 'error', 'Choose smart placement, a monetized community, or the Crowdwide-feed fallback.');
      return res.redirect('/advertising');
    }
    const minimumBudget = Number(settings.advertisingMinimumCampaignBudget ?? 25);
    const budget = Number(req.body.totalBudget);
    if (!Number.isFinite(budget) || budget < minimumBudget) {
      flash(req, 'error', `Campaign budget must be at least ${minimumBudget} Waves.`);
      return res.redirect('/advertising');
    }
    let destination;
    try {
      destination = new URL(String(req.body.destinationUrl || '').trim());
      if (!['http:', 'https:'].includes(destination.protocol) || !destination.hostname) throw new Error('invalid');
    } catch {
      flash(req, 'error', 'Add a valid http or https destination link for your advertisement.');
      return res.redirect('/advertising');
    }
    if (req.body.endDate) {
      const end = new Date(req.body.endDate);
      if (Number.isNaN(end.getTime()) || end < new Date(new Date().toISOString().slice(0, 10))) {
        flash(req, 'error', 'The end date cannot be in the past.');
        return res.redirect('/advertising');
      }
    }

    // The logo uploaded with an ad is that ad's logo; on the first ad it also becomes the business logo.
    const logoFile = req.files?.logo?.[0] || null;
    const bannerFile = req.files?.banner?.[0];
    const [storedLogo, storedBanner] = await Promise.all([
      logoFile
        ? uploadBuffer(logoFile.buffer, logoFile.originalname, logoFile.mimetype, { kind: 'advertiser-logo', owner: req.session.user.id })
        : null,
      bannerFile
        ? uploadBuffer(bannerFile.buffer, bannerFile.originalname, bannerFile.mimetype, { kind: 'advertisement-banner', owner: req.session.user.id })
        : null
    ]);

    const result = await submitAdvertisement({
      userId: req.session.user.id,
      acceptedTerms: true,
      business: {
        businessName: req.body.businessName,
        businessDescription: req.body.businessDescription,
        website: req.body.website,
        notes: String(req.body.notes || '').trim().slice(0, 2000),
        logoUrl: storedLogo ? mediaUrl(storedLogo) : ''
      },
      campaign: {
        title: req.body.title,
        brandName: String(req.body.brandName || '').trim().slice(0, 120),
        brandLogoUrl: storedLogo ? mediaUrl(storedLogo) : '',
        campaignType: req.body.campaignType,
        productName: req.body.productName,
        productPrice: req.body.productPrice,
        advertisingRightsConfirmed: true,
        description: req.body.description,
        destinationUrl: destination.toString(),
        bannerUrl: storedBanner ? mediaUrl(storedBanner) : '',
        sitewideFallback,
        smartPlacement,
        keywords: String(req.body.keywords || ''),
        totalBudget: budget,
        dailyBudget: req.body.dailyBudget,
        minimumBudget,
        impressionCostWaves: settings.advertisingCostPerImpression ?? 0.1,
        clickCostWaves: settings.advertisingCostPerClick ?? 1,
        startDate: req.body.startDate || undefined,
        endDate: req.body.endDate || undefined,
        targetCommunities
      }
    });
    flash(req, 'success', `Ad submitted and ${result.campaign.totalBudget.toLocaleString()} Waves reserved. After moderator and admin approval it goes live automatically.`);
  } catch (error) {
    logger.warn('Advertisement submission failed', { userId: req.session.user.id, error });
    flash(req, 'error', error.message || 'Your ad could not be submitted.');
  }
  return res.redirect('/advertising');
};

// Lets an advertiser keep their business profile current (logo, banner, website, description).
// The business name stays fixed; a different brand name can be set per ad.
exports.updateProfile = async (req, res) => {
  const advertiser = await getOwnedAdvertiser(req.session.user.id);
  if (!advertiser || advertiser.status === 'suspended') {
    flash(req, 'error', 'Your advertiser profile cannot be edited right now.');
    return res.redirect('/advertising');
  }
  try {
    const website = String(req.body.website || '').trim();
    if (website && (!/^https?:\/\//i.test(website) || website.length > 300)) throw new Error('Enter a valid website URL starting with http:// or https://.');
    const description = String(req.body.businessDescription || '').trim().slice(0, 500);
    if (!description) throw new Error('Add a short business description.');
    const logoFile = req.files?.logo?.[0];
    const bannerFile = req.files?.banner?.[0];
    const [storedLogo, storedBanner] = await Promise.all([
      logoFile ? uploadBuffer(logoFile.buffer, logoFile.originalname, logoFile.mimetype, { kind: 'advertiser-logo', owner: req.session.user.id }) : null,
      bannerFile ? uploadBuffer(bannerFile.buffer, bannerFile.originalname, bannerFile.mimetype, { kind: 'advertisement-banner', owner: req.session.user.id }) : null
    ]);
    advertiser.website = website;
    advertiser.businessDescription = description;
    if (storedLogo) advertiser.logoUrl = mediaUrl(storedLogo);
    if (storedBanner) advertiser.bannerUrl = mediaUrl(storedBanner);
    if (req.body.removeLogo === 'on' && !storedLogo) advertiser.logoUrl = '';
    await advertiser.save();
    flash(req, 'success', 'Business profile updated.');
  } catch (error) {
    flash(req, 'error', error.message || 'Your business profile could not be updated.');
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
  if (req.body.action === 'submit'
    && (advertiser.termsVersion !== ADVERTISING_TERMS_VERSION || !advertiser.termsAcceptedAt)) {
    flash(req, 'error', 'Accept the current Advertising Terms before submitting campaigns.');
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
      flash(req, 'success', `Campaign stopped. Any unused budget was refunded to your Waves wallet, and the campaign data will be deleted in ${AD_RETENTION_DAYS} days.`);
    } else {
      throw new Error('Choose a valid campaign action.');
    }
  } catch (error) {
    logger.warn('Advertiser campaign action failed', { campaignId: campaign._id, userId: req.session.user.id, error });
    flash(req, 'error', error.message || 'The campaign action could not be completed.');
  }
  return res.redirect('/advertising');
};

exports.trackCampaignImpression = async (req, res) => {
  try {
    await recordCampaignEvent({
      campaignId: req.params.id,
      communityId: req.body.communityId,
      viewerId: req.session.user.id,
      eventType: 'impression',
      deliveryContext: req.body.deliveryContext || 'community',
      eventToken: req.body.eventToken
    });
    return res.status(204).end();
  } catch (error) {
    if (error.code === 'ADVERTISEMENT_UNAVAILABLE') return res.status(404).json({ error: error.message });
    logger.error('Advertisement impression could not be recorded', { campaignId: req.params.id, error });
    return res.status(503).json({ error: 'The advertisement impression could not be recorded.' });
  }
};

exports.clickCampaign = async (req, res) => {
  try {
    const result = await recordCampaignEvent({
      campaignId: req.params.id,
      communityId: req.query.community,
      deliveryContext: req.query.context || 'community',
      viewerId: req.session.user.id,
      eventType: 'click',
      eventToken: req.query.event
    });
    if (!result.destinationUrl) return res.status(404).render('pages/not-found', { title: 'Advertisement unavailable' });
    return res.redirect(result.destinationUrl);
  } catch (error) {
    if (error.code === 'ADVERTISEMENT_UNAVAILABLE') {
      return res.status(404).render('pages/not-found', { title: 'Advertisement unavailable' });
    }
    logger.error('Advertisement click could not be recorded', { campaignId: req.params.id, error });
    return res.status(503).type('text/plain').send('The advertisement link could not be verified. Please try again later.');
  }
};

exports.reportCampaign = async (req, res) => {
  const reason = String(req.body.reason || '').trim().slice(0, 500);
  const communityId = String(req.body.communityId || '');
  const deliveryContext = String(req.body.deliveryContext || 'community');
  const campaign = await Campaign.findById(req.params.id).select('title targetCommunities sitewideFallback smartPlacement').lean();
  if (deliveryContext === 'sitewide') {
    if (!campaign || !campaign.sitewideFallback || (campaign.targetCommunities || []).length || !reason) {
      flash(req, 'error', 'That advertisement could not be reported.');
      return res.redirect('/dashboard');
    }
  } else if (deliveryContext !== 'community' || !communityId) {
    flash(req, 'error', 'That advertisement could not be reported.');
    return res.redirect('/explore');
  }
  const community = deliveryContext === 'community'
    ? await Community.findById(communityId).select('slug').lean()
    : null;
  if (!campaign || !reason || (deliveryContext === 'community'
    && (!community || !((campaign.targetCommunities || []).some((id) => String(id) === communityId)
      || (!(campaign.targetCommunities || []).length && (campaign.smartPlacement || campaign.sitewideFallback)))))) {
    flash(req, 'error', 'That advertisement could not be reported.');
    return res.redirect(community ? `/communities/${community.slug}` : '/dashboard');
  }
  try {
    await Report.updateOne(
      { reporter: req.session.user.id, targetType: 'advertisement', target: campaign._id },
      { $setOnInsert: { reporter: req.session.user.id, targetType: 'advertisement', target: campaign._id, reason, contextText: `Advertisement: ${campaign.title} · ${deliveryContext === 'sitewide' ? 'Crowdwide feed' : `Community: ${community.slug}`}` } },
      { upsert: true }
    );
    flash(req, 'success', 'The advertisement was reported to the moderation team.');
  } catch (error) {
    logger.error('Advertisement report could not be saved', error);
    flash(req, 'error', 'The report could not be submitted. Please try again.');
  }
  return res.redirect(community ? `/communities/${community.slug}` : '/dashboard');
};
