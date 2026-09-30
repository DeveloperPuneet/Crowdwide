// Real numbers behind the About-page charts, computed from published posts in
// PUBLIC communities only (private communities never contribute). Results are
// cached for ten minutes so the public page can't be used to hammer the database.
const Post = require('../models/Post');
const Community = require('../models/Community');
const { buildLineChart } = require('../utils/lineChart');

const WEEKS = 8;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_MS = 10 * 60 * 1000;
let cache = null;

function tierThresholds(env = process.env) {
  const large = Math.max(2, Number(env.STATS_LARGE_COMMUNITY_MIN) || 50);
  const mid = Math.min(large - 1, Math.max(1, Number(env.STATS_MID_COMMUNITY_MIN) || 10));
  return { mid, large };
}

function weekLabels(start, weeks = WEEKS) {
  return Array.from({ length: weeks }, (_, i) => new Date(start + i * WEEK_MS).toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' }));
}

async function computeGrowthStats(now = Date.now()) {
  const start = now - WEEKS * WEEK_MS;
  const { mid, large } = tierThresholds();
  const newCommunityWindowMs = 30 * DAY_MS;

  const publicCommunities = await Community.find({ isPrivate: { $ne: true } }).select('_id createdAt membersCount').lean();
  const communityInfo = new Map(publicCommunities.map((c) => [String(c._id), c]));
  const communityIds = publicCommunities.map((c) => c._id);

  const posts = communityIds.length
    ? await Post.find({ status: 'published', community: { $in: communityIds }, createdAt: { $gte: new Date(start) } }).select('community createdAt viewsCount').lean()
    : [];

  const newViews = Array(WEEKS).fill(0);
  const newCount = Array(WEEKS).fill(0);
  const oldViews = Array(WEEKS).fill(0);
  const oldCount = Array(WEEKS).fill(0);
  const tierPosts = { mid: Array(WEEKS).fill(0), large: Array(WEEKS).fill(0) };

  for (const post of posts) {
    const community = communityInfo.get(String(post.community));
    if (!community) continue;
    const created = new Date(post.createdAt).getTime();
    const week = Math.min(WEEKS - 1, Math.max(0, Math.floor((created - start) / WEEK_MS)));
    const communityAge = created - new Date(community.createdAt).getTime();
    if (communityAge <= newCommunityWindowMs) { newViews[week] += post.viewsCount || 0; newCount[week] += 1; }
    else { oldViews[week] += post.viewsCount || 0; oldCount[week] += 1; }
    const members = community.membersCount || 0;
    if (members >= large) tierPosts.large[week] += 1;
    else if (members >= mid) tierPosts.mid[week] += 1;
  }

  const communitiesInTier = {
    large: publicCommunities.filter((c) => (c.membersCount || 0) >= large).length,
    mid: publicCommunities.filter((c) => (c.membersCount || 0) >= mid && (c.membersCount || 0) < large).length
  };
  const avg = (sum, n) => (n ? Math.round((sum / n) * 10) / 10 : null);
  const labels = weekLabels(start);

  const reach = buildLineChart({
    labels,
    series: [
      { key: 'crowdwide', name: 'Posts in new communities (under 30 days old)', values: newViews.map((v, i) => avg(v, newCount[i])) },
      { key: 'typical', name: 'Posts in established communities', values: oldViews.map((v, i) => avg(v, oldCount[i])) }
    ]
  });
  const size = buildLineChart({
    labels,
    series: [
      { key: 'intermediate', name: `Intermediate communities (${mid}–${large - 1} members)`, values: tierPosts.mid.map((n) => (communitiesInTier.mid ? Math.round((n / communitiesInTier.mid) * 10) / 10 : null)) },
      { key: 'large', name: `Large communities (${large}+ members)`, values: tierPosts.large.map((n) => (communitiesInTier.large ? Math.round((n / communitiesInTier.large) * 10) / 10 : null)) }
    ]
  });

  return {
    reach,
    size,
    totals: {
      posts: posts.length,
      communities: publicCommunities.length,
      newCommunityPosts: newCount.reduce((a, b) => a + b, 0),
      establishedPosts: oldCount.reduce((a, b) => a + b, 0),
      largeCommunities: communitiesInTier.large,
      intermediateCommunities: communitiesInTier.mid
    },
    thresholds: { mid, large },
    weeks: WEEKS,
    updatedAt: new Date(now)
  };
}

async function getGrowthStats() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = await computeGrowthStats();
  cache = { at: Date.now(), value };
  return value;
}

function clearGrowthStatsCache() { cache = null; }

module.exports = { getGrowthStats, computeGrowthStats, clearGrowthStatsCache, tierThresholds };
