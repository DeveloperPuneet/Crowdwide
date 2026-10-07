const Community = require('../models/Community');
const User = require('../models/User');
const Post = require('../models/Post');
const Report = require('../models/Report');
const CampaignEvent = require('../models/CampaignEvent');
const WavesLedgerEntry = require('../models/WavesLedgerEntry');
const SiteSetting = require('../models/SiteSetting');
const Quest = require('../models/Quest');
const crypto = require('node:crypto');
const { uploadBuffer, mediaUrl } = require('../services/storageCluster');
const { parseHashtagList } = require('../utils/hashtags');
const { getViralPosts, getPopularPeople, getCommonInterestPeople, getMutualNetworkPeople, getTrendingCreators, getNewJoiners } = require('../services/discovery');
const { getInterestProfile, topInterestTags, refreshPersonalization } = require('../services/feedService');
const { COMMUNITY_CATEGORIES, normalizeCommunityCategory } = require('../utils/communityCategories');
const { rewardWavesForAction } = require('../services/waves');
const { getCommunityCampaigns } = require('../services/advertising');
const { getCommunityPromotionOffer, getActiveCommunityPromotions, promoteCommunity } = require('../services/communityPromotion');
const logger = require('../services/logger');

async function getMonetizationEligibility(communityId) {
  const [settings, results, community] = await Promise.all([
    SiteSetting.getSingleton(),
    Post.aggregate([
      { $match: { community: communityId, status: 'published' } },
      { $group: {
        _id: null,
        posts: { $sum: 1 },
        likes: { $sum: { $size: { $ifNull: ['$likes', []] } } },
        comments: { $sum: { $ifNull: ['$commentsCount', 0] } },
        lastPostAt: { $max: '$createdAt' }
      } }
    ]),
    Community.findById(communityId).select('owner createdAt isPrivate')
  ]);
  const totals = results[0] || { posts: 0, likes: 0, comments: 0 };
  const [owner, confirmedViolations] = await Promise.all([
    community ? User.findById(community.owner).select('isVerified suspendedUntil postingRestrictedUntil warnings').lean() : null,
    (async () => {
      const communityPostIds = await Post.distinct('_id', { community: communityId });
      return Report.countDocuments({
        status: 'resolved',
        $or: [
          { targetType: 'community', target: communityId },
          { targetType: 'post', target: { $in: communityPostIds } }
        ]
      });
    })()
  ]);
  const now = new Date();
  const activityDays = Number(settings.monetizationRecentActivityDays ?? 30);
  const activityCutoff = new Date(now.getTime() - activityDays * 24 * 60 * 60 * 1000);
  const communityAgeDays = community?.createdAt
    ? Math.floor((now.getTime() - new Date(community.createdAt).getTime()) / (24 * 60 * 60 * 1000))
    : 0;
  const recentWarningCutoff = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
  const recentWarnings = (owner?.warnings || []).filter((warning) => new Date(warning.createdAt || 0) >= recentWarningCutoff);
  const ownerInGoodStanding = Boolean(
    owner?.isVerified
    && !(owner.suspendedUntil && owner.suspendedUntil > now)
    && !(owner.postingRestrictedUntil && owner.postingRestrictedUntil > now)
    && recentWarnings.length === 0
  );
  const requirements = {
    posts: { label: 'Published posts', actual: Number(totals.posts || 0), minimum: Number(settings.monetizationMinimumPosts ?? 20) },
    likes: { label: 'Total post likes', actual: Number(totals.likes || 0), minimum: Number(settings.monetizationMinimumLikes ?? 30) },
    comments: { label: 'Total comments', actual: Number(totals.comments || 0), minimum: Number(settings.monetizationMinimumComments ?? 10) },
    age: { label: 'Community age (days)', actual: communityAgeDays, minimum: Number(settings.monetizationMinimumCommunityAgeDays ?? 30) },
    activity: { label: `Published activity within ${activityDays} days`, actual: Boolean(totals.lastPostAt && new Date(totals.lastPostAt) >= activityCutoff), minimum: true },
    ownerStanding: { label: 'Owner account in good standing', actual: ownerInGoodStanding, minimum: true },
    policyHistory: { label: 'No upheld community policy violations', actual: Number(confirmedViolations) === 0, minimum: true },
    public: { label: 'Public community', actual: Boolean(community && !community.isPrivate), minimum: true }
  };
  Object.values(requirements).forEach((requirement) => {
    requirement.met = typeof requirement.actual === 'boolean'
      ? requirement.actual === requirement.minimum
      : requirement.actual >= requirement.minimum;
  });
  return { requirements, eligible: Object.values(requirements).every((requirement) => requirement.met) };
}

const loadCommunity = async (req, res, next) => {
  const community = await Community.findById(req.params.id);
  if (!community) {
    req.session.flash = { type: 'error', message: 'That community could not be found.' };
    return res.redirect('/communities');
  }
  req.community = community;
  next();
};

const moderationOnly = async (req, res, next) => {
  const community = req.community || await Community.findById(req.params.id);
  const isOwner = community && String(community.owner) === String(req.session.user.id);
  const isModerator = community?.moderators?.some((id) => String(id) === String(req.session.user.id));
  if (!community || (!isOwner && !isModerator)) {
    req.session.flash = { type: 'error', message: 'You do not have moderation access to this community.' };
    return res.redirect('/dashboard');
  }
  req.community = community;
  req.isOwner = isOwner;
  next();
};

const ownerOnly = async (req, res, next) => {
  const community = await Community.findOne({ _id: req.params.id, owner: req.session.user.id }).select('+inviteCode');
  if (!community) {
    req.session.flash = { type: 'error', message: 'Only the community owner can manage this community.' };
    return res.redirect('/dashboard');
  }
  req.community = community;
  req.isOwner = true;
  next();
};

exports.ownerOnly = ownerOnly;
exports.moderationOnly = moderationOnly;
exports.loadCommunity = loadCommunity;

const getRisingCommunities = async (limit = 12) => {
  const now = new Date();
  const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const communities = await Community.find({ isPrivate: false, membersCount: { $gte: 1 } })
    .select('name slug description category hashtags membersCount avatarImage createdAt')
    .sort({ membersCount: -1, createdAt: -1 })
    .lean();

  if (!communities.length) return [];

  const communityIds = communities.map((community) => community._id);
  const recentActivity = await Post.aggregate([
    { $match: { status: 'published', community: { $in: communityIds }, createdAt: { $gte: lastWeek } } },
    { $group: {
        _id: '$community',
        count: { $sum: 1 },
        likes: { $sum: { $size: '$likes' } },
        commentSignals: { $sum: '$commentsCount' },
        shares: { $sum: '$sharesCount' },
        views: { $sum: '$viewsCount' }
      }
    }
  ]);

  const activityByCommunity = new Map(recentActivity.map((entry) => [String(entry._id), entry]));

  return communities
    .map((community) => {
      const stats = activityByCommunity.get(String(community._id)) || { count: 0, likes: 0, commentSignals: 0, shares: 0, views: 0 };
      const communityScore = ((stats.count * 12) + (stats.likes * 1.3) + (stats.commentSignals * 2.5) + (stats.shares * 3.2) + (stats.views * 0.1) + ((community.membersCount || 0) * 0.18));
      return {
        ...community,
        recentPosts: stats.count,
        recentLikes: stats.likes,
        recentComments: stats.commentSignals,
        recentShares: stats.shares,
        recentViews: stats.views,
        score: Number(communityScore.toFixed(2))
      };
    })
    .filter((community) => community.recentPosts > 0 || (community.membersCount || 0) >= 25)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
};

exports.communityMap = async (req, res) => {
  const filter = {
    isPrivate: false,
    showOnMap: true,
    locationLabel: { $type: 'string', $ne: '' },
    locationLat: { $gte: -90, $lte: 90 },
    locationLng: { $gte: -180, $lte: 180 }
  };
  const [mapCommunities, categories] = await Promise.all([
    Community.find(filter).sort({ membersCount: -1, name: 1 }).limit(500).select('name slug description category hashtags membersCount avatarImage locationLabel locationLat locationLng').lean(),
    Community.distinct('category', filter)
  ]);
  res.render('pages/community-map', {
    title: 'Community Galaxy',
    description: 'Explore public Crowdwide communities by location, interests, and category.',
    pagePath: '/community-map',
    noIndex: true,
    includeLeaflet: true,
    mapApiKey: process.env.MAPTILER_API_KEY || '',
    mapCommunities,
    categories: categories.filter(Boolean).sort()
  });
};

exports.risingCommunities = async (req, res) => {
  const risingCommunities = await getRisingCommunities();
  res.render('pages/rising-communities', {
    title: 'Rising communities',
    description: 'Discover communities growing fastest this week on Crowdwide.',
    pagePath: '/communities/rising',
    noIndex: true,
    risingCommunities
  });
};

exports.explore = async (req, res) => {
  const query = req.query.q?.trim();
  const category = req.query.category?.trim().toLowerCase();
  const filter = {};
  if (query) {
    const tag = query.startsWith('#') ? query.slice(1).toLowerCase() : null;
    filter.$or = tag ? [{ hashtags: tag }, { name: new RegExp(query, 'i') }] : [{ name: new RegExp(query, 'i') }, { description: new RegExp(query, 'i') }, { hashtags: query.toLowerCase() }];
  }
  if (category) filter.category = category;
  const isBrowsing = Boolean(query || category);
  const [communities, categories, newPeople, popularPeople, viralPosts, risingCommunities, promotedCommunities] = await Promise.all([
    Community.find(filter).sort({ membersCount: -1, createdAt: -1 }).limit(30).lean(),
    Community.distinct('category'),
    isBrowsing ? Promise.resolve([]) : User.find({ _id: { $ne: req.session.user.id }, isVerified: true }).sort({ createdAt: -1 }).limit(6).select('name bio profilePicture createdAt').lean(),
    isBrowsing ? Promise.resolve([]) : getPopularPeople(6, [req.session.user.id]),
    isBrowsing ? Promise.resolve([]) : getViralPosts(4),
    isBrowsing ? Promise.resolve([]) : getRisingCommunities(4),
    isBrowsing ? Promise.resolve([]) : getActiveCommunityPromotions()
  ]);
  const promotedIds = new Set(promotedCommunities.map((community) => String(community._id)));
  const communityList = isBrowsing
    ? communities
    : communities.filter((community) => !promotedIds.has(String(community._id)));
  res.render('pages/explore', { title: 'Explore', pagePath: '/explore', noIndex: true, communities: communityList, categories, query: query || '', category: category || '', newPeople, popularPeople, viralPosts, risingCommunities, promotedCommunities, isBrowsing });
};

// A dedicated, always-full-width page for people recommendations - the
// small "People to follow" panel this replaced lived inside the
// discover-column aside, which the site's own layout hides between roughly
// 900-1150px viewport widths (and only reappears stacked far below the
// feed on narrower screens), so it was effectively unusable on a lot of
// real devices. This page has no such column to disappear into.
exports.peopleToFollow = async (req, res) => {
  const user = await User.findById(req.session.user.id).select('following joinedCommunities blockedUsers mutedUsers bookmarks hashtags searchHistory createdAt recentViews').lean();
  const followingIds = (user.following || []).map(String);
  const excludeIds = [req.session.user.id, ...followingIds, ...(user.blockedUsers || []).map(String)];
  const profile = await getInterestProfile(user);
  const tags = Array.from(new Set([...(user.hashtags || []), ...topInterestTags(profile.interests, 10)]));

  const [commonInterests, mutualNetwork, trending, newJoiners] = await Promise.all([
    getCommonInterestPeople(tags, excludeIds, 8),
    getMutualNetworkPeople(followingIds, excludeIds, 8),
    getTrendingCreators(excludeIds, 8),
    getNewJoiners(excludeIds, 8)
  ]);

  res.render('pages/people', {
    title: 'People to follow',
    pagePath: '/people',
    noIndex: true,
    commonInterests,
    mutualNetwork,
    trending,
    newJoiners,
    hasInterests: tags.length > 0
  });
};

exports.directory = async (req, res) => {
  const [communities, viralPosts, newPosts, promotedCommunities] = await Promise.all([
    Community.find().sort({ membersCount: -1, createdAt: -1 }).limit(60).lean(),
    getViralPosts(8),
    Post.find({ status: 'published', community: { $exists: true } }).sort({ createdAt: -1 }).limit(20).populate('author', 'name profilePicture').populate('community', 'name slug').lean(),
    getActiveCommunityPromotions()
  ]);
  const promotedIds = new Set(promotedCommunities.map((community) => String(community._id)));
  const regularCommunities = communities.filter((community) => !promotedIds.has(String(community._id)));
  const latestCommunityIds = new Set(regularCommunities.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 8).map((community) => String(community._id)));
  const growing = regularCommunities.filter((community) => !latestCommunityIds.has(String(community._id))).sort((a, b) => (b.membersCount || 0) - (a.membersCount || 0));
  res.render('pages/communities', {
    title: 'Communities',
    pagePath: '/communities',
    noIndex: true,
    promotedCommunities,
    largerCommunities: regularCommunities.slice(0, 8),
    newCommunities: regularCommunities.filter((community) => latestCommunityIds.has(String(community._id))),
    growingCommunities: growing.slice(0, 8),
    viralPosts,
    newPosts,
    viralArticles: viralPosts.filter((post) => post.type === 'article'),
    latestArticles: newPosts.filter((post) => post.type === 'article'),
    latestPosts: newPosts.filter((post) => post.type !== 'article')
  });
};

exports.mine = async (req, res) => {
  const communities = await Community.find({ owner: req.session.user.id }).sort({ createdAt: -1 }).lean();
  res.render('pages/my-communities', {
    title: 'Your communities',
    pagePath: '/communities/mine',
    noIndex: true,
    communities,
    communityCategories: COMMUNITY_CATEGORIES
  });
};

exports.detail = async (req, res) => {
  const community = await Community.findOne({ slug: req.params.slug }).populate('owner', 'name profilePicture').lean();
  if (!community) return res.status(404).render('pages/not-found', { title: 'Community not found' });
  const joined = community.members.some((id) => String(id) === String(req.session.user.id));
  const requested = community.joinRequests?.some((request) => String(request.user) === String(req.session.user.id));
  const moderatorIds = (community.moderators || []).map(String);
  const isOwner = community.owner && String(community.owner._id) === String(req.session.user.id);
  // A private community's posts and member list are for members only - the
  // "Request to join" flow below is the only thing a non-member should see.
  if (community.isPrivate && !joined) {
    return res.render('pages/community-request', { title: `Request to join ${community.name}`, pagePath: `/communities/${community.slug}`, noIndex: true, community, requested });
  }
  const pinnedIds = (community.pinnedPosts || []).map(String);
  const [recentPosts, pinnedPosts, members, quests] = await Promise.all([
    Post.find({ community: community._id, status: 'published' }).sort({ createdAt: -1 }).limit(30).populate('author', 'name profilePicture').lean(),
    pinnedIds.length ? Post.find({ _id: { $in: pinnedIds }, community: community._id, status: 'published' }).populate('author', 'name profilePicture').lean() : Promise.resolve([]),
    User.find({ _id: { $in: community.members } }).select('name profilePicture').limit(60).lean(),
    Quest.find({ community: community._id }).sort({ createdAt: -1 }).populate('creator', 'name profilePicture').populate('participants', 'name profilePicture').populate('completedBy', 'name profilePicture').populate('winner', 'name profilePicture').lean()
  ]);
  const pinnedById = new Map(pinnedPosts.map((post) => [String(post._id), post]));
  const posts = [
    ...pinnedIds.map((id) => pinnedById.get(id)).filter(Boolean),
    ...recentPosts.filter((post) => !pinnedById.has(String(post._id)))
  ];
  const communityAds = await getCommunityCampaigns(community._id);
  const placement = community.monetizationSettings?.adPlacement || 'feed';
  const frequency = Math.max(1, Math.min(10, Math.floor(Number(community.monetizationSettings?.adFrequency) || 1)));
  const feedAds = [];
  if (['feed', 'all'].includes(placement)) {
    for (let afterPost = frequency; afterPost <= posts.length && feedAds.length < 3; afterPost += frequency) {
      const campaign = communityAds[feedAds.length % communityAds.length];
      if (!campaign) break;
      feedAds.push({ campaign, eventToken: crypto.randomUUID(), afterPost });
    }
  }
  const sidebarAds = ['sidebar', 'all'].includes(placement) && communityAds.length
    ? [{ campaign: communityAds[0], eventToken: crypto.randomUUID() }]
    : [];
  res.render('pages/community-detail', { title: community.name, pagePath: `/communities/${community.slug}`, noIndex: true, community, posts, members, moderatorIds, joined, requested, isOwner, locked: false, quests, feedAds, sidebarAds });
};
exports.manage = async (req, res) => {
  const [members, posts, pendingPosts, requests, moderators, quests, monetizationEligibility, adEvents, communityPromotionOffer, ownerEarnings, ownerEarningsHistory] = await Promise.all([
    User.find({ _id: { $in: req.community.members } }).select('name email profilePicture').lean(),
    Post.find({ community: req.community._id, status: 'published' }).sort({ createdAt: -1 }).limit(20).populate('author', 'name profilePicture').lean(),
    Post.find({ community: req.community._id, status: 'pending' }).sort({ createdAt: -1 }).limit(30).populate('author', 'name profilePicture').lean(),
    User.find({ _id: { $in: req.community.joinRequests.map((request) => request.user) } }).select('name email').lean(),
    User.find({ _id: { $in: req.community.moderators } }).select('name email').lean(),
    Quest.find({ community: req.community._id }).sort({ createdAt: -1 }).populate('creator', 'name').populate('participants', 'name').populate('completedBy', 'name').populate('winner', 'name').lean(),
    getMonetizationEligibility(req.community._id),
    CampaignEvent.aggregate([
      { $match: { community: req.community._id } },
      { $group: {
        _id: '$eventType',
        count: { $sum: 1 },
        campaignSpendWaves: { $sum: { $ifNull: ['$wavesCharged', 0] } }
      } }
    ]),
    getCommunityPromotionOffer(),
    WavesLedgerEntry.aggregate([
      { $match: { user: req.community.owner, community: req.community._id, type: 'earn', status: 'posted', referenceType: 'community-ad-share' } },
      { $group: { _id: null, total: { $sum: '$amount' }, entries: { $sum: 1 } } }
    ]),
    WavesLedgerEntry.find({
      user: req.community.owner,
      community: req.community._id,
      type: 'earn',
      referenceType: 'community-ad-share'
    }).sort({ createdAt: -1, _id: -1 }).limit(20).lean()
  ]);
  const monetizationStats = {
    impressions: Number(adEvents.find((event) => event._id === 'impression')?.count || 0),
    clicks: Number(adEvents.find((event) => event._id === 'click')?.count || 0),
    campaignSpendWaves: Number(adEvents.reduce((total, event) => total + Number(event.campaignSpendWaves || 0), 0)),
    ownerShareWaves: Number(ownerEarnings[0]?.total || 0),
    ownerShareEntries: Number(ownerEarnings[0]?.entries || 0)
  };
  const base = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  res.render('pages/community-owner', { title: `${req.community.name} controls`, pagePath: `/communities/${req.community._id}/manage`, noIndex: true, includeLeaflet: true, mapApiKey: process.env.MAPTILER_API_KEY || '', community: req.community, communityCategories: COMMUNITY_CATEGORIES, inviteUrl: req.community.inviteCode ? `${base.replace(/\/$/, '')}/communities/invite/${req.community.inviteCode}` : '', members, posts, pendingPosts, requests, moderators, quests, monetizationEligibility, monetizationStats, ownerEarningsHistory, communityPromotionOffer, isOwner: req.isOwner ?? String(req.community.owner) === String(req.session.user.id) });
};

exports.promoteCommunity = async (req, res) => {
  try {
    const result = await promoteCommunity({ communityId: req.community._id, userId: req.session.user.id });
    req.session.flash = {
      type: 'success',
      message: `Your community is promoted for ${result.durationHours} hours for ${result.wavesCost} Waves.`
    };
  } catch (error) {
    logger.warn('Community promotion could not be completed', {
      userId: req.session.user.id,
      communityId: req.community._id,
      error
    });
    const expected = /Only the community owner|Private communities|already has an active|already being processed|temporarily held|Suspended accounts|active posting restriction|verified account|not have enough Waves|currently unavailable|not configured|contact support/i.test(error.message);
    req.session.flash = {
      type: 'error',
      message: expected ? error.message : 'The community promotion could not be completed. Please try again later.'
    };
  }
  return res.redirect(`/communities/${req.community._id}/manage#promotion`);
};

exports.submitMonetizationApplication = async (req, res) => {
  const community = req.community;
  if (community.monetizationApplication?.appealStatus === 'pending') {
    req.session.flash = { type: 'error', message: 'A monetization appeal is already awaiting review.' };
    return res.redirect(`/communities/${community._id}/manage#monetization`);
  }
  if (['pending', 'approved'].includes(community.monetizationStatus)) {
    req.session.flash = { type: 'error', message: 'This community already has an active monetization application or approval.' };
    return res.redirect(`/communities/${community._id}/manage#monetization`);
  }
  const eligibility = await getMonetizationEligibility(community._id);
  if (!eligibility.eligible) {
    req.session.flash = { type: 'error', message: 'This community does not yet meet all monetization requirements.' };
    return res.redirect(`/communities/${community._id}/manage#monetization`);
  }

  const previousMonetizationApplication = community.monetizationApplication && typeof community.monetizationApplication.toObject === 'function' ? community.monetizationApplication.toObject() : (community.monetizationApplication || {});
  community.monetizationApplication = {
    ...previousMonetizationApplication,
    applicantName: req.session.user?.name || '',
    submittedAt: new Date(),
    rejectionReason: '',
    appealMessage: '',
    appealStatus: '',
    appealedAt: null
  };
  community.monetizationStatus = 'pending';
  community.monetizationModeratorReview = { status: 'pending', reason: '', reviewedAt: null, reviewedBy: null };
  community.isMonetized = false;
  community.monetizationSettings = {
    ...(community.monetizationSettings?.toObject?.() || community.monetizationSettings || {}),
    adsEnabled: false,
    requiresAdminReview: true
  };
  community.monetizationHistory = [
    ...(community.monetizationHistory || []).slice(-9),
    { status: 'pending', action: 'application-submitted', note: 'Community monetization application submitted for moderator screening.', createdAt: new Date(), actor: req.session.user.id }
  ];
  community.monetizationUpdatedAt = new Date();
  await community.save();

  req.session.flash = { type: 'success', message: 'Your monetization application has been submitted for review.' };
  res.redirect(`/communities/${community._id}/manage#monetization`);
};

exports.submitMonetizationAppeal = async (req, res) => {
  const community = req.community;
  const application = community.monetizationApplication || {};
  const message = String(req.body.message || '').trim().slice(0, 1000);
  if (!['rejected', 'paused'].includes(community.monetizationStatus)) {
    req.session.flash = { type: 'error', message: 'Only rejected or paused monetization decisions can be appealed.' };
    return res.redirect(`/communities/${community._id}/manage#monetization`);
  }
  if (application.appealStatus === 'pending') {
    req.session.flash = { type: 'error', message: 'A monetization appeal is already awaiting review.' };
    return res.redirect(`/communities/${community._id}/manage#monetization`);
  }
  if (message.length < 20) {
    req.session.flash = { type: 'error', message: 'Please include at least 20 characters explaining your appeal.' };
    return res.redirect(`/communities/${community._id}/manage#monetization`);
  }
  community.monetizationApplication = {
    ...(application.toObject?.() || application),
    appealMessage: message,
    appealStatus: 'pending',
    appealedAt: new Date()
  };
  community.monetizationHistory = [
    ...(community.monetizationHistory || []).slice(-19),
    { status: community.monetizationStatus, action: 'appeal-submitted', note: message.slice(0, 500), createdAt: new Date(), actor: req.session.user.id }
  ];
  community.monetizationUpdatedAt = new Date();
  await community.save();
  req.session.flash = { type: 'success', message: 'Your monetization appeal has been submitted to the admin team.' };
  return res.redirect(`/communities/${community._id}/manage#monetization`);
};

exports.getMonetizationEligibility = getMonetizationEligibility;

exports.createQuest = async (req, res) => {
  const title = req.body.title?.trim();
  if (!title) {
    req.session.flash = { type: 'error', message: 'A quest needs a title.' };
    return res.redirect(`/communities/${req.community._id}/manage`);
  }
  const quest = await Quest.create({
    community: req.community._id,
    creator: req.session.user.id,
    title: title.slice(0, 80),
    description: req.body.description?.trim().slice(0, 260) || '',
    goal: req.body.goal?.trim().slice(0, 150) || '',
    reward: req.body.reward?.trim().slice(0, 120) || '',
    achievementTag: req.body.achievementTag?.trim().slice(0, 60) || '',
    status: 'open'
  });
  req.session.flash = { type: 'success', message: `Quest “${quest.title}” is live.` };
  res.redirect(`/communities/${req.community._id}/manage`);
};

exports.toggleQuestParticipation = async (req, res) => {
  const quest = await Quest.findOne({ _id: req.params.questId, community: req.community._id });
  if (!quest) {
    req.session.flash = { type: 'error', message: 'That quest no longer exists.' };
    return res.redirect(`/communities/${req.community.slug}`);
  }
  if (!req.community.members.some((id) => String(id) === String(req.session.user.id))) {
    req.session.flash = { type: 'error', message: 'Join the community before joining its quests.' };
    return res.redirect(`/communities/${req.community.slug}`);
  }
  if (['ended', 'archived'].includes(quest.status)) {
    req.session.flash = { type: 'error', message: 'This quest has already ended.' };
    return res.redirect(req.get('referer') || `/communities/${req.community.slug}`);
  }
  const userId = req.session.user.id;
  const isJoined = quest.participants.some((id) => String(id) === String(userId));
  if (isJoined) {
    quest.participants.pull(userId);
    quest.completedBy.pull(userId);
    if (String(quest.winner) === String(userId)) quest.winner = null;
    req.session.flash = { type: 'success', message: 'You left this quest.' };
  } else {
    quest.participants.addToSet(userId);
    req.session.flash = { type: 'success', message: 'You joined the quest.' };
  }
  quest.status = quest.completedBy.length ? 'completed' : (quest.participants.length ? 'active' : 'open');
  if (quest.status === 'completed' && !quest.winner && quest.completedBy.length) quest.winner = quest.completedBy[0];
  await quest.save();
  res.redirect(req.get('referer') || `/communities/${req.community.slug}`);
};

exports.completeQuest = async (req, res) => {
  const quest = await Quest.findOne({ _id: req.params.questId, community: req.community._id });
  if (!quest) {
    req.session.flash = { type: 'error', message: 'That quest no longer exists.' };
    return res.redirect(`/communities/${req.community.slug}`);
  }
  if (!req.community.members.some((id) => String(id) === String(req.session.user.id))) {
    req.session.flash = { type: 'error', message: 'Join the community before completing its quests.' };
    return res.redirect(`/communities/${req.community.slug}`);
  }
  if (['ended', 'archived'].includes(quest.status)) {
    req.session.flash = { type: 'error', message: 'This quest is already closed.' };
    return res.redirect(req.get('referer') || `/communities/${req.community.slug}`);
  }
  const userId = req.session.user.id;
  const isJoined = quest.participants.some((id) => String(id) === String(userId));
  if (!isJoined) {
    req.session.flash = { type: 'error', message: 'Join the quest before marking it complete.' };
    return res.redirect(req.get('referer') || `/communities/${req.community.slug}`);
  }
  const isCompleted = quest.completedBy.some((id) => String(id) === String(userId));
  if (isCompleted) quest.completedBy.pull(userId);
  else quest.completedBy.addToSet(userId);
  if (quest.completedBy.length) {
    quest.status = 'completed';
    quest.winner = quest.completedBy[0];
  } else {
    quest.status = 'active';
    quest.winner = null;
  }
  await quest.save();
  if (!isCompleted) {
    rewardWavesForAction({ userId, action: 'questCompletion', referenceType: 'quest', referenceId: quest._id })
      .catch((error) => logger.error('Could not award Waves for quest completion', error));
  }
  req.session.flash = { type: 'success', message: isCompleted ? 'Quest marked as not completed.' : 'Quest marked as complete.' };
  res.redirect(req.get('referer') || `/communities/${req.community.slug}`);
};

exports.endQuest = async (req, res) => {
  const quest = await Quest.findOne({ _id: req.params.questId, community: req.community._id });
  if (!quest) {
    req.session.flash = { type: 'error', message: 'That quest no longer exists.' };
    return res.redirect(`/communities/${req.community._id}/manage`);
  }
  const winnerId = req.body.winnerId || quest.completedBy[0] || quest.participants[0];
  const validWinner = quest.participants.some((id) => String(id) === String(winnerId));
  quest.winner = validWinner ? winnerId : null;
  quest.status = 'ended';
  quest.endedAt = new Date();
  quest.rewarded = quest.rewarded || false;
  await quest.save();
  const winner = quest.winner ? await User.findById(quest.winner).select('name').lean() : null;
  req.session.flash = { type: 'success', message: winner ? `Quest closed. Winner: ${winner.name}` : 'Quest closed without a winner.' };
  res.redirect(`/communities/${req.community._id}/manage`);
};

exports.rewardQuestWinner = async (req, res) => {
  const quest = await Quest.findOne({ _id: req.params.questId, community: req.community._id });
  if (!quest) {
    req.session.flash = { type: 'error', message: 'That quest no longer exists.' };
    return res.redirect(`/communities/${req.community._id}/manage`);
  }
  if (!quest.winner) {
    req.session.flash = { type: 'error', message: 'Choose a winner before marking the reward.' };
    return res.redirect(`/communities/${req.community._id}/manage`);
  }
  quest.rewarded = true;
  quest.rewardSentAt = new Date();
  await quest.save();
  req.session.flash = { type: 'success', message: 'Reward marked as sent.' };
  res.redirect(`/communities/${req.community._id}/manage`);
};

exports.update = async (req, res) => {
  const showOnMap = req.body.showOnMap === 'on';
  const locationLabel = req.body.locationLabel?.trim().slice(0, 100) || '';
  const rawLocationLat = String(req.body.locationLat || '').trim();
  const rawLocationLng = String(req.body.locationLng || '').trim();
  const parsedLocationLat = Number(rawLocationLat);
  const parsedLocationLng = Number(rawLocationLng);
  if (showOnMap && (!locationLabel || !rawLocationLat || !rawLocationLng || !Number.isFinite(parsedLocationLat) || parsedLocationLat < -90 || parsedLocationLat > 90 || !Number.isFinite(parsedLocationLng) || parsedLocationLng < -180 || parsedLocationLng > 180)) {
    req.session.flash = { type: 'error', message: 'Choose a general location on the map and enter its city or region before listing this community.' };
    return res.redirect(`/communities/${req.community._id}/manage`);
  }
  const locationLat = Number.isFinite(parsedLocationLat) ? Number(parsedLocationLat.toFixed(2)) : undefined;
  const locationLng = Number.isFinite(parsedLocationLng) ? Number(parsedLocationLng.toFixed(2)) : undefined;
  req.community.name = req.body.name?.trim() || req.community.name;
  req.community.description = req.body.description?.trim() || req.community.description;
  req.community.guidelines = req.body.guidelines?.trim().slice(0, 4000) || req.community.guidelines;
  const category = normalizeCommunityCategory(req.body.category, req.community.category);
  if (!category) {
    req.session.flash = { type: 'error', message: 'Choose a category from the list.' };
    return res.redirect(`/communities/${req.community._id}/manage`);
  }
  req.community.category = category;
  req.community.isPrivate = req.body.isPrivate === 'on';
  if (!req.community.isPrivate) req.community.inviteCode = undefined;
  req.community.showOnMap = showOnMap;
  req.community.locationLabel = showOnMap ? locationLabel : '';
  req.community.locationLat = showOnMap ? locationLat : undefined;
  req.community.locationLng = showOnMap ? locationLng : undefined;
  req.community.requireApproval = req.body.requireApproval === 'on';
  req.community.bannedWords = (req.body.bannedWords || '').split(',').map((word) => word.trim().toLowerCase()).filter(Boolean).slice(0, 100);
  if (req.body.hashtags !== undefined) req.community.hashtags = parseHashtagList(req.body.hashtags);

  const avatar = req.files?.avatarImage?.[0];
  const banner = req.files?.bannerImage?.[0];
  if (avatar) {
    const stored = await uploadBuffer(avatar.buffer, avatar.originalname, avatar.mimetype, { kind: 'community-avatar', community: String(req.community._id) });
    req.community.avatarImage = mediaUrl(stored);
  }
  if (banner) {
    const stored = await uploadBuffer(banner.buffer, banner.originalname, banner.mimetype, { kind: 'community-banner', community: String(req.community._id) });
    req.community.coverImage = mediaUrl(stored);
  }

  await req.community.save();
  req.session.flash = { type: 'success', message: 'Community details updated.' };
  res.redirect(`/communities/${req.community._id}/manage`);
};

exports.createInvite = async (req, res) => {
  if (!req.community.isPrivate) {
    req.session.flash = { type: 'error', message: 'Invite links are only available for private communities.' };
    return res.redirect(`/communities/${req.community._id}/manage`);
  }
  req.community.inviteCode = crypto.randomBytes(32).toString('hex');
  await req.community.save();
  req.session.flash = { type: 'success', message: 'Invite link created. Anyone with the link can join immediately.' };
  res.redirect(`/communities/${req.community._id}/manage`);
};

exports.revokeInvite = async (req, res) => {
  req.community.inviteCode = undefined;
  await req.community.save();
  req.session.flash = { type: 'success', message: 'Community invite link turned off.' };
  res.redirect(`/communities/${req.community._id}/manage`);
};

exports.invitePreview = async (req, res) => {
  const community = await Community.findOne({ inviteCode: req.params.code, isPrivate: true }).select('name slug description').lean();
  if (!community) return res.status(404).render('pages/not-found', { title: 'Invite link not found' });
  res.render('pages/community-invite', {
    title: `Join ${community.name}`,
    pagePath: `/communities/invite/${req.params.code}`,
    noIndex: true,
    community,
    inviteJoinUrl: `/communities/invite/${req.params.code}/join`
  });
};

exports.joinByInvite = async (req, res) => {
  const community = await Community.findOne({ inviteCode: req.params.code, isPrivate: true });
  if (!community) {
    req.session.flash = { type: 'error', message: 'That invite link is invalid or has expired.' };
    return res.redirect('/explore');
  }
  const userId = req.session.user.id;
  if (!community.members.some((id) => String(id) === String(userId))) {
    community.members.addToSet(userId);
    if (!community.memberRoles.some((entry) => String(entry.user) === String(userId))) community.memberRoles.push({ user: userId, role: 'member' });
    community.joinRequests = community.joinRequests.filter((request) => String(request.user) !== String(userId));
    community.membersCount = community.members.length;
    await community.save();
    await User.findByIdAndUpdate(userId, { $addToSet: { joinedCommunities: community._id } });
    rewardWavesForAction({ userId, action: 'communityJoin', referenceType: 'community', referenceId: community._id })
      .catch((error) => logger.error('Could not award Waves for joining a community', error));
    refreshPersonalization(userId);
  }
  req.session.flash = { type: 'success', message: `You joined ${community.name}.` };
  res.redirect(`/communities/${community.slug}`);
};

exports.addModerator = async (req, res) => {
  const identifier = req.body.identifier?.trim();
  if (!identifier) return res.redirect(`/communities/${req.community._id}/manage`);
  const lookup = identifier.includes('@') ? { email: identifier.toLowerCase() } : { name: new RegExp(`^${identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') };
  const person = await User.findOne(lookup).select('_id').lean();
  if (!person) {
    req.session.flash = { type: 'error', message: 'No Crowdwide member matches that username or email.' };
    return res.redirect(`/communities/${req.community._id}/manage`);
  }
  if (String(person._id) === String(req.community.owner)) {
    req.session.flash = { type: 'error', message: 'The community owner already has full moderation access.' };
    return res.redirect(`/communities/${req.community._id}/manage`);
  }
  req.community.members = req.community.members || [];
  req.community.memberRoles = req.community.memberRoles || [];
  req.community.moderators = req.community.moderators || [];
  const alreadyMember = req.community.members.some((id) => String(id) === String(person._id));
  if (!alreadyMember) {
    req.community.members.addToSet(person._id);
    req.community.membersCount = req.community.members.length;
    await User.findByIdAndUpdate(person._id, { $addToSet: { joinedCommunities: req.community._id } });
  }
  const role = req.community.memberRoles.find((entry) => String(entry.user) === String(person._id));
  if (role) role.role = 'moderator';
  else req.community.memberRoles.push({ user: person._id, role: 'moderator' });
  req.community.moderators.addToSet(person._id);
  await req.community.save();
  req.session.flash = { type: 'success', message: 'Moderator added.' };
  res.redirect(`/communities/${req.community._id}/manage`);
};

exports.reviewPost = async (req, res) => {
  const post = await Post.findOne({ _id: req.params.postId, community: req.community._id, status: 'pending' });
  if (post) {
    post.status = req.body.decision === 'approve' ? 'published' : 'rejected';
    await post.save();
  }
  res.redirect(`/communities/${req.community._id}/manage`);
};

exports.togglePinPost = async (req, res) => {
  const post = await Post.findOne({ _id: req.params.postId, community: req.community._id, status: 'published' }).select('_id').lean();
  if (!post) return res.redirect(`/communities/${req.community._id}/manage`);
  req.community.pinnedPosts = req.community.pinnedPosts || [];
  const isPinned = req.community.pinnedPosts.some((id) => String(id) === String(post._id));
  if (isPinned) req.community.pinnedPosts.pull(post._id);
  else if (req.community.pinnedPosts.length < 3) req.community.pinnedPosts.addToSet(post._id);
  else req.session.flash = { type: 'error', message: 'A community can have up to three pinned posts.' };
  await req.community.save();
  if (isPinned || req.community.pinnedPosts.some((id) => String(id) === String(post._id))) req.session.flash = { type: 'success', message: isPinned ? 'Post unpinned.' : 'Post pinned.' };
  res.redirect(`/communities/${req.community._id}/manage`);
};

exports.requestJoin = async (req, res) => {
  const community = await Community.findById(req.params.id);
  if (!community) return res.redirect('/explore');
  const userId = req.session.user.id;
  if (community.members.some((id) => String(id) === String(userId))) return res.redirect(`/communities/${community.slug}`);
  if (community.isPrivate) {
    if (!community.joinRequests.some((request) => String(request.user) === String(userId))) community.joinRequests.push({ user: userId });
    await community.save();
    req.session.flash = { type: 'success', message: 'Join request sent to the community moderators.' };
    return res.redirect(`/communities/${community.slug}`);
  } else {
    community.members.push(userId);
    community.memberRoles.push({ user: userId, role: 'member' });
    community.membersCount = community.members.length;
    await community.save();
    await User.findByIdAndUpdate(userId, { $addToSet: { joinedCommunities: community._id } });
    rewardWavesForAction({ userId, action: 'communityJoin', referenceType: 'community', referenceId: community._id })
      .catch((error) => logger.error('Could not award Waves for joining a community', error));
    refreshPersonalization(userId);
  }
  res.redirect(req.get('referer') || `/communities/${community.slug}`);
};

exports.leaveCommunity = async (req, res) => {
  const community = await Community.findById(req.params.id);
  if (!community) return res.redirect('/explore');
  const userId = req.session.user.id;
  if (String(community.owner) === String(userId)) {
    req.session.flash = { type: 'error', message: 'The community owner cannot leave their community.' };
    return res.redirect(`/communities/${community.slug}`);
  }
  if (!community.members.some((id) => String(id) === String(userId))) {
    req.session.flash = { type: 'error', message: 'You are not a member of this community.' };
    return res.redirect(`/communities/${community.slug}`);
  }

  community.members.pull(userId);
  community.moderators.pull(userId);
  community.memberRoles = community.memberRoles.filter((entry) => String(entry.user) !== String(userId));
  community.joinRequests = community.joinRequests.filter((request) => String(request.user) !== String(userId));
  community.membersCount = community.members.length;
  await community.save();
  await User.findByIdAndUpdate(userId, { $pull: { joinedCommunities: community._id } });
  refreshPersonalization(userId);
  req.session.flash = { type: 'success', message: `You left ${community.name}.` };
  res.redirect(`/communities/${community.slug}`);
};

exports.cancelJoinRequest = async (req, res) => {
  const community = await Community.findById(req.params.id);
  if (!community) return res.redirect('/explore');
  const userId = req.session.user.id;
  const hadRequest = community.joinRequests.some((request) => String(request.user) === String(userId));
  if (hadRequest) {
    community.joinRequests = community.joinRequests.filter((request) => String(request.user) !== String(userId));
    await community.save();
    req.session.flash = { type: 'success', message: 'Your join request was cancelled.' };
  } else {
    req.session.flash = { type: 'error', message: 'You do not have a pending request for this community.' };
  }
  res.redirect(`/communities/${community.slug}`);
};

exports.reviewRequest = async (req, res) => {
  const request = req.community.joinRequests.find((item) => String(item.user) === req.params.userId);
  if (request && req.body.decision === 'approve') {
    req.community.members.addToSet(request.user);
    req.community.memberRoles.push({ user: request.user, role: 'member' });
    req.community.membersCount = req.community.members.length;
    await User.findByIdAndUpdate(request.user, { $addToSet: { joinedCommunities: req.community._id } });
    rewardWavesForAction({ userId: request.user, action: 'communityJoin', referenceType: 'community', referenceId: req.community._id })
      .catch((error) => logger.error('Could not award Waves for joining a community', error));
  }
  req.community.joinRequests = req.community.joinRequests.filter((item) => String(item.user) !== req.params.userId);
  await req.community.save();
  res.redirect(`/communities/${req.community._id}/manage`);
};

exports.setModerator = async (req, res) => {
  if (!req.isOwner || String(req.params.userId) === String(req.community.owner)) {
    req.session.flash = { type: 'error', message: 'Only the owner can change moderator roles.' };
    return res.redirect(`/communities/${req.community._id}/manage`);
  }
  if (!['member', 'moderator'].includes(req.body.role)) return res.redirect(`/communities/${req.community._id}/manage`);
  const member = req.community.members.some((id) => String(id) === req.params.userId);
  if (!member) {
    req.session.flash = { type: 'error', message: 'Only community members can receive a moderator role.' };
    return res.redirect(`/communities/${req.community._id}/manage`);
  }
  req.community.memberRoles = req.community.memberRoles || [];
  req.community.moderators = req.community.moderators || [];
  if (req.body.role === 'moderator') req.community.moderators.addToSet(req.params.userId);
  else req.community.moderators.pull(req.params.userId);
  const role = req.community.memberRoles.find((entry) => String(entry.user) === req.params.userId);
  if (role) role.role = req.body.role;
  else req.community.memberRoles.push({ user: req.params.userId, role: req.body.role });
  await req.community.save();
  req.session.flash = { type: 'success', message: req.body.role === 'moderator' ? 'Moderator added.' : 'Moderator removed.' };
  res.redirect(`/communities/${req.community._id}/manage`);
};

exports.removeMember = async (req, res) => {
  const memberId = req.params.memberId;
  if (String(memberId) === String(req.community.owner)) {
    req.session.flash = { type: 'error', message: 'The community owner cannot be removed.' };
    return res.redirect(`/communities/${req.community._id}/manage`);
  }
  req.community.members.pull(memberId);
  req.community.moderators.pull(memberId);
  req.community.memberRoles = req.community.memberRoles.filter((entry) => String(entry.user) !== String(memberId));
  req.community.membersCount = req.community.members.length;
  await req.community.save();
  await User.findByIdAndUpdate(memberId, { $pull: { joinedCommunities: req.community._id } });
  req.session.flash = { type: 'success', message: 'Member removed from the community.' };
  res.redirect(`/communities/${req.community._id}/manage`);
};
