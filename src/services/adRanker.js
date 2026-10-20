// Ad selection for community pages.
//
// Every eligible campaign gets a score from four signals, then ads are drawn by
// weighted random sampling (not strict ranking) so the best ads win most of the time,
// new ads still get a fair chance to prove themselves, and budgets are spent evenly.
//   relevance - overlap between the campaign's keywords/text and the community's topic
//   quality   - click-through rate, smoothed so a handful of impressions cannot mislead
//   pacing    - how much budget (total and today's daily cap) is left against the time left
//   freshness - a short boost for campaigns that have had few impressions
// A fatigue penalty lowers ads this viewer already saw recently, and only one ad per
// advertiser is chosen per page.

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'your', 'you', 'our', 'this', 'that', 'from', 'are', 'was', 'has', 'have', 'all', 'new', 'get', 'out', 'can', 'will', 'not', 'but', 'its', 'any', 'more']);
const PRIOR_CTR = 0.02;
const PRIOR_WEIGHT = 200;

const tokens = (text = '') => String(text).toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !STOP_WORDS.has(word));

function contextTerms(context = {}) {
  const set = new Set();
  [...(context.hashtags || []), ...(context.keywords || []), context.category, context.name, context.description]
    .forEach((value) => tokens(value || '').forEach((word) => set.add(word)));
  return set;
}

function relevanceOf(campaign, terms) {
  if (!terms.size) return 0.3;
  const explicit = new Set((campaign.keywords || []).flatMap((keyword) => tokens(keyword)));
  const implicit = new Set([...tokens(campaign.title), ...tokens(campaign.description), ...tokens(campaign.productName)]);
  let hits = 0;
  explicit.forEach((word) => { if (terms.has(word)) hits += 2; });
  implicit.forEach((word) => { if (terms.has(word)) hits += 1; });
  // Saturating curve: a couple of matches already count as clearly relevant.
  return 1 - Math.exp(-hits / 3);
}

function qualityOf(campaign) {
  const impressions = Number(campaign.impressions || 0);
  const clicks = Number(campaign.clicks || 0);
  const smoothed = (clicks + PRIOR_CTR * PRIOR_WEIGHT) / (impressions + PRIOR_WEIGHT);
  return Math.min(1, smoothed / 0.08);
}

function pacingOf(campaign, now) {
  const total = Number(campaign.totalBudget || 0);
  const remaining = Number(campaign.remainingBudget || 0);
  if (total <= 0 || remaining <= 0) return 0;
  let score = Math.min(1, remaining / total + 0.2);
  const end = campaign.endDate ? new Date(campaign.endDate).getTime() : null;
  if (end && end > now) {
    // Spend faster when the budget is large relative to the days left.
    const daysLeft = Math.max(1, (end - now) / 86400000);
    score = Math.min(1, score + Math.min(0.3, (remaining / total) / daysLeft));
  }
  const daily = Number(campaign.dailyBudget || 0);
  if (daily > 0) {
    const sameDay = campaign.dailyBudgetDate && new Date(campaign.dailyBudgetDate).toDateString() === new Date(now).toDateString();
    const spentToday = sameDay ? Number(campaign.dailyBudgetSpent || 0) : 0;
    if (spentToday >= daily) return 0;
    score *= Math.max(0.2, 1 - spentToday / daily);
  }
  return score;
}

function freshnessOf(campaign) {
  return 1 / (1 + Number(campaign.impressions || 0) / 150);
}

function scoreCampaign(campaign, { terms, seen = new Map(), now = Date.now() }) {
  const relevance = relevanceOf(campaign, terms);
  const quality = qualityOf(campaign);
  const pacing = pacingOf(campaign, now);
  if (pacing <= 0) return 0;
  const freshness = freshnessOf(campaign);
  const base = 0.45 * relevance + 0.25 * quality + 0.2 * pacing + 0.1 * freshness;
  const fatigue = 1 / (1 + 1.5 * Number(seen.get(String(campaign._id)) || 0));
  // A campaign that targets this community explicitly always beats a generic one.
  const targeted = (campaign.targetCommunities || []).length ? 1.25 : 1;
  return Math.max(0.01, base * fatigue * targeted);
}

// Picks up to `limit` campaigns, at most one per advertiser, weighted by score.
function selectAds(campaigns, { context = {}, seen = new Map(), limit = 3, now = Date.now(), rng = Math.random } = {}) {
  const terms = contextTerms(context);
  const pool = campaigns
    .map((campaign) => ({ campaign, score: scoreCampaign(campaign, { terms, seen, now }) }))
    .filter((entry) => entry.score > 0);
  const chosen = [];
  const advertisers = new Set();
  while (pool.length && chosen.length < limit) {
    const total = pool.reduce((sum, entry) => sum + entry.score, 0);
    let pick = rng() * total;
    let index = pool.findIndex((entry) => (pick -= entry.score) <= 0);
    if (index < 0) index = pool.length - 1;
    const [entry] = pool.splice(index, 1);
    const advertiserId = String(entry.campaign.advertiser?._id || entry.campaign.advertiser || entry.campaign._id);
    if (advertisers.has(advertiserId)) continue;
    advertisers.add(advertiserId);
    chosen.push(entry.campaign);
  }
  return chosen;
}

module.exports = { selectAds, scoreCampaign, relevanceOf, qualityOf, pacingOf, contextTerms, tokens };
