const Advertiser = require('../models/Advertiser');
const Campaign = require('../models/Campaign');
const Community = require('../models/Community');
const Report = require('../models/Report');
const Appeal = require('../models/Appeal');
const SiteSetting = require('../models/SiteSetting');
const { uploadBuffer, mediaUrl } = require('../services/storageCluster');
const logger = require('../services/logger');
const {
  createCampaign,
  ADVERTISING_TERMS_VERSION,
  registerAdvertiser,
  submitCampaign,
  updateCampaignStatus,
  recordCampaignEvent,
  getCampaignAnalytics,
  hasMonetizedPublicCommunity
} = require('../services/advertising');

function flash(req, type, message) {
  req.session.flash = { type, message };
}

async function getOwnedAdvertiser(userId) {
  return Advertiser.findOne({ user: userId });
}

exports.dashboard = async (req, res) => {
  const advertiser = await Advertiser.findOne({ user: req.session.user.id })
    .populate('moderationHistory.actor', 'name role');
  const [campaigns, communities, advertiserAppeal, siteSettings, sitewideFallbackAvailable] = await Promise.all([
    advertiser
      ? Campaign.find({ advertiser: advertiser._id })
        .sort({ createdAt: -1 })
        .limit(100)
        .populate('moderationHistory.actor', 'name role')
        .lean()
      : [],
    Community.find({ monetizationStatus: 'approved', isMonetized: true, isPrivate: false, 'monetizationSettings.adsEnabled': true })
      .select('name slug')
      .sort({ name: 1 })
      .limit(300)
      .lean(),
    advertiser
      ? Appeal.findOne({ user: req.session.user.id, advertiser: advertiser._id, actionType: 'advertiser', status: 'pending' }).lean()
      : null,
    SiteSetting.getSingleton(),
    hasMonetizedPublicCommunity().then((hasMonetizedCommunity) => !hasMonetizedCommunity)
  ]);
  const campaignAnalytics = await getCampaignAnalytics(campaigns.map((campaign) => campaign._id));
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
    sitewideFallbackAvailable,
    advertisingMinimumCampaignBudget: Number(siteSettings.advertisingMinimumCampaignBudget ?? 25),
    campaignAnalytics,
    totals,
    advertisingTermsVersion: ADVERTISING_TERMS_VERSION,
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

exports.apply = async (req, res) => {
  const name = String(req.body.businessName || '').trim();
  const website = String(req.body.website || '').trim();
  if (!name) {
    flash(req, 'error', 'Enter your business or organization name.');
    return res.redirect('/advertising');
  }
  if (req.body.acceptAdvertisingTerms !== 'on') {
    flash(req, 'error', 'Accept the Advertising Terms before applying.');
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
      notes: String(req.body.notes || '').trim().slice(0, 2000),
      acceptedTerms: true
    });
    flash(req, 'success', 'Advertiser application submitted for admin review.');
  } catch (error) {
    logger.error('Advertiser application failed', error);
    flash(req, 'error', 'The advertiser application could not be saved. Please try again.');
  }
  return res.redirect('/advertising');
};

exports.acceptTerms = async (req, res) => {
  if (req.body.acceptAdvertisingTerms !== 'on') {
    flash(req, 'error', 'Confirm that you accept the Advertising Terms.');
    return res.redirect('/advertising');
  }
  const advertiser = await getOwnedAdvertiser(req.session.user.id);
  if (!advertiser) {
    flash(req, 'error', 'Apply as an advertiser before accepting advertiser terms.');
    return res.redirect('/advertising');
  }
  try {
    advertiser.termsAcceptedAt = new Date();
    advertiser.termsVersion = ADVERTISING_TERMS_VERSION;
    await advertiser.save();
  } catch (error) {
    logger.error('Advertising Terms acceptance could not be saved', error);
    flash(req, 'error', 'Your acceptance could not be saved. Please try again.');
    return res.redirect('/advertising');
  }
  flash(req, 'success', 'Advertising Terms accepted.');
  return res.redirect('/advertising');
};

exports.createCampaign = async (req, res) => {
  const advertiser = await getOwnedAdvertiser(req.session.user.id);
  if (!advertiser || advertiser.status !== 'approved') {
    flash(req, 'error', 'An approved advertiser profile is required to create a campaign.');
    return res.redirect('/advertising');
  }
  if (advertiser.termsVersion !== ADVERTISING_TERMS_VERSION || !advertiser.termsAcceptedAt) {
    flash(req, 'error', 'Accept the current Advertising Terms before creating or submitting campaigns.');
    return res.redirect('/advertising');
  }

  const targetCommunities = Array.isArray(req.body.targetCommunities)
    ? req.body.targetCommunities
    : [req.body.targetCommunities].filter(Boolean);
  const sitewideFallback = req.body.sitewideFallback === 'on';
  try {
    const [eligibleTargets, settings, hasMonetizedCommunity] = await Promise.all([
      Community.find({
        _id: { $in: targetCommunities },
        monetizationStatus: 'approved',
        isMonetized: true,
        isPrivate: false,
        'monetizationSettings.adsEnabled': true
      }).select('_id').lean(),
      SiteSetting.getSingleton(),
      hasMonetizedPublicCommunity()
    ]);
    if (eligibleTargets.length !== new Set(targetCommunities.map(String)).size) {
      flash(req, 'error', 'Choose only public communities that currently accept approved ads.');
      return res.redirect('/advertising');
    }
    if (sitewideFallback && (hasMonetizedCommunity || targetCommunities.length)) {
      flash(req, 'error', 'Crowdwide-feed campaigns are available only when no public community is monetized.');
      return res.redirect('/advertising');
    }
    if (!targetCommunities.length && !sitewideFallback) {
      flash(req, 'error', 'Choose a monetized community or select the Crowdwide-feed fallback.');
      return res.redirect('/advertising');
    }
    const budget = Number(req.body.totalBudget);
    if (!Number.isFinite(budget) || budget < Number(settings.advertisingMinimumCampaignBudget ?? 25)) {
      flash(req, 'error', `Campaign budget must be at least ${Number(settings.advertisingMinimumCampaignBudget ?? 25)} Waves.`);
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
    let bannerUrl = '';
    if (req.file) {
      const uploaded = await uploadBuffer(req.file.buffer, req.file.originalname, req.file.mimetype, {
        kind: 'advertisement-banner',
        owner: req.session.user.id
      });
      bannerUrl = mediaUrl(uploaded);
    }
    await createCampaign({
      advertiserId: advertiser._id,
      title: req.body.title,
      description: req.body.description,
      destinationUrl: destination.toString(),
      bannerUrl,
      sitewideFallback,
      totalBudget: budget,
      dailyBudget: req.body.dailyBudget,
      minimumBudget: settings.advertisingMinimumCampaignBudget ?? 25,
      impressionCostWaves: settings.advertisingCostPerImpression ?? 0.1,
      clickCostWaves: settings.advertisingCostPerClick ?? 1,
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
  const campaign = await Campaign.findById(req.params.id).select('title targetCommunities sitewideFallback').lean();
  if (deliveryContext === 'sitewide') {
    if (!campaign || !campaign.sitewideFallback || (campaign.targetCommunities || []).length
      || await hasMonetizedPublicCommunity() || !reason) {
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
    && (!community || !(campaign.targetCommunities || []).some((id) => String(id) === communityId)))) {
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
