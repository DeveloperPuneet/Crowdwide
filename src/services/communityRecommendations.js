// "Explore communities" on the dashboard: the few public communities that best
// match what this member is into. Pure scoring lives in rankCommunities so it
// can be tested without a database.
const Community = require('../models/Community');
const { categoriesForInterests } = require('../utils/onboardingInterests');

const DEFAULT_LIMIT = 5;
const CANDIDATE_LIMIT = 150;

const words = (value) => String(value || '').toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 3);

// interests: Map(tag -> 0..1). favouriteCategories: Set of community categories
// the member picked in onboarding. Returns up to `limit` communities, best first.
// Matching communities always come before filler; popular ones fill any gap so
// the panel is never empty.
function rankCommunities(communities = [], { interests = new Map(), favouriteCategories = new Set(), limit = DEFAULT_LIMIT } = {}) {
  const weight = (tag) => interests.get(String(tag || '').toLowerCase()) || 0;
  const maxMembers = Math.max(1, ...communities.map((community) => community.membersCount || 0));
  const scored = communities.map((community) => {
    const tagWeights = (community.hashtags || []).map(weight).filter((value) => value > 0).sort((a, b) => b - a);
    const tagScore = tagWeights.length ? Math.min(1, tagWeights[0] + 0.35 * (tagWeights[1] || 0) + 0.15 * (tagWeights[2] || 0)) : 0;
    const category = String(community.category || '').toLowerCase();
    const categoryScore = favouriteCategories.has(category) ? 0.7 : Math.max(0, ...words(category).map(weight)) * 0.6;
    // name/description words count a little, so a community with no hashtags can still match.
    const textScore = Math.max(0, ...words(`${community.name} ${community.description}`).map(weight)) * 0.3;
    const match = Math.min(1, Math.max(tagScore, categoryScore) + 0.5 * Math.min(tagScore, categoryScore) + textScore);
    const popularity = Math.log1p(community.membersCount || 0) / Math.log1p(maxMembers);
    const ageDays = (Date.now() - new Date(community.createdAt || 0).getTime()) / 86400000;
    // small communities with a real match get a nudge so large ones don't always win.
    const freshness = ageDays < 30 ? 0.05 : 0;
    return { community, match, score: match * 0.8 + popularity * 0.15 + freshness };
  });
  scored.sort((a, b) => b.score - a.score || (b.community.membersCount || 0) - (a.community.membersCount || 0));
  const matching = scored.filter((entry) => entry.match >= 0.1);
  const rest = scored.filter((entry) => entry.match < 0.1);
  return [...matching, ...rest].slice(0, limit).map((entry) => entry.community);
}

async function getRecommendedCommunities(user, { limit = DEFAULT_LIMIT, getInterestProfile } = {}) {
  const joined = (user.joinedCommunities || []).map(String);
  const candidates = await Community.find({
    isPrivate: false,
    owner: { $ne: user._id },
    members: { $ne: user._id },
    _id: { $nin: joined }
  }).sort({ membersCount: -1, createdAt: -1 }).limit(CANDIDATE_LIMIT).select('name slug description category hashtags membersCount owner avatarImage createdAt').lean();
  if (!candidates.length) return [];
  let interests = new Map();
  try {
    interests = (await getInterestProfile(user)).interests || new Map();
  } catch (error) {
    interests = new Map();
  }
  const favouriteCategories = new Set(categoriesForInterests(user.hashtags || []));
  return rankCommunities(candidates, { interests, favouriteCategories, limit });
}

module.exports = { rankCommunities, getRecommendedCommunities, DEFAULT_LIMIT };
