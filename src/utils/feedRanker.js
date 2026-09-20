// Crowdwide feed ranking - pure functions only (no database access), so the
// whole algorithm can be unit-tested and tuned in one place.
//
// How a feed is built
// -------------------
// 1. The service gathers candidate posts (see services/feedService.js).
// 2. Every candidate is scored for the tab being viewed (scorePost).
// 3. Candidates are split into two lanes:
//      network   - people you follow, communities you joined, your own posts
//      discovery - everyone else on the platform ("other parts of Crowdwide")
// 4. The lanes are mixed so that ~37.5% (always inside 35-40%) of what you see
//    comes from outside your existing network. That is the growth lever: new
//    voices and small communities get real reach - but the discovery lane is
//    itself ranked by your interests and post quality, so it stays relevant
//    instead of random.
// 5. Author diversity rules stop one person from filling the screen.

const PAGE_SIZE = 16; // multiple of 8, so every page holds exactly 6 discovery posts at 37.5%
const DEFAULT_DISCOVERY_RATIO = 0.375;
const MIN_DISCOVERY_RATIO = 0.35;
const MAX_DISCOVERY_RATIO = 0.4;

const TAB_CONFIG = {
  'for-you': { types: null, mixing: 'strict', halfLifeHours: 24 },
  'my-community': { types: null, mixing: 'strict', halfLifeHours: 36 },
  'posts-new': { types: ['post', 'poll'], mixing: 'floor', halfLifeHours: 12 },
  'posts-viral': { types: ['post', 'poll'], mixing: 'floor', halfLifeHours: 24 },
  'articles-new': { types: ['article'], mixing: 'floor', halfLifeHours: 48 },
  'articles-viral': { types: ['article'], mixing: 'floor', halfLifeHours: 72 }
};
const TABS = Object.keys(TAB_CONFIG);

const ENGAGEMENT_WEIGHTS = { likes: 1, reactions: 1.5, comments: 3, shares: 4, pollVotes: 1.2, views: 0.05 };
const GRAVITY = 1.35;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Keeps the operator's FEED_DISCOVERY_RATIO inside the agreed 35-40% band.
function resolveDiscoveryRatio(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DISCOVERY_RATIO;
  return clamp(parsed, MIN_DISCOVERY_RATIO, MAX_DISCOVERY_RATIO);
}

function isFeedTab(value) {
  return TABS.includes(value);
}

// Deterministic 0..1 value from a string (FNV-1a). Used for a tiny per-user,
// per-hour shuffle so a refresh does not always return the identical order.
function hash01(input) {
  let hash = 2166136261;
  const text = String(input);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
}

function ageHours(createdAt, now = Date.now()) {
  const time = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime();
  if (!Number.isFinite(time)) return 24 * 365;
  return Math.max(0, (now - time) / HOUR_MS);
}

function engagementPoints(counts = {}) {
  return (counts.likes || 0) * ENGAGEMENT_WEIGHTS.likes
    + (counts.reactions || 0) * ENGAGEMENT_WEIGHTS.reactions
    + (counts.comments || 0) * ENGAGEMENT_WEIGHTS.comments
    + (counts.shares || 0) * ENGAGEMENT_WEIGHTS.shares
    + (counts.pollVotes || 0) * ENGAGEMENT_WEIGHTS.pollVotes
    + (counts.views || 0) * ENGAGEMENT_WEIGHTS.views;
}

// Hacker-News style "hot" value: engagement decays with age so yesterday's
// hit does not sit above a post that is taking off right now.
function hotValue(points, hours) {
  return points / Math.pow(hours + 2, GRAVITY);
}

function freshness(hours, halfLifeHours) {
  return Math.pow(0.5, hours / halfLifeHours);
}

// Overlap between a post's hashtags and the viewer's interest map
// (tag -> weight in 0..1). Best match counts fully, the next two add a little.
function interestScore(tags = [], interests) {
  if (!interests || !tags.length) return 0;
  const weights = tags.map((tag) => (interests.get ? interests.get(tag) : interests[tag]) || 0).filter((weight) => weight > 0).sort((a, b) => b - a);
  if (!weights.length) return 0;
  return clamp(weights[0] + 0.35 * (weights[1] || 0) + 0.15 * (weights[2] || 0), 0, 1);
}

// Turns weighted signals ([{ tags, weight }]) into a normalized interest map.
function buildInterestMap(signals = []) {
  const raw = new Map();
  signals.forEach(({ tags = [], weight = 1 }) => {
    tags.forEach((tag) => {
      const key = String(tag || '').toLowerCase();
      if (key) raw.set(key, (raw.get(key) || 0) + weight);
    });
  });
  const max = Math.max(0, ...raw.values());
  if (!max) return new Map();
  // sqrt softens the gap so a single hobby does not drown everything else.
  return new Map(Array.from(raw, ([tag, value]) => [tag, Math.sqrt(value / max)]));
}

// Boost for under-exposed voices: brand-new accounts, accounts nobody
// follows yet, and small communities. Only applies to posts that clear a
// basic quality bar, so it cannot be farmed with junk.
function growthBoost({ authorAgeDays, authorFollowers, communityMembers, qualifies = true }) {
  if (!qualifies) return 0;
  const newAuthor = Number.isFinite(authorAgeDays) ? Math.max(0, 1 - authorAgeDays / 45) : 0;
  const smallReach = Number.isFinite(authorFollowers) ? 1 / (1 + authorFollowers / 12) : 0.3;
  const authorSide = 0.5 * newAuthor + 0.5 * smallReach;
  const communitySide = Number.isFinite(communityMembers) ? 1 / (1 + communityMembers / 20) : 0;
  return clamp(Math.max(authorSide, communitySide), 0, 1);
}

function passesQualityBar(post) {
  const substantial = (post.bodyLength || 0) >= 25 || post.hasMedia || post.type === 'poll';
  return Boolean(substantial) && post.moderationStatus !== 'needs-review' && (post.moderationScore || 0) >= 0;
}

function qualityAdjustment(post) {
  let adjustment = 0;
  if (post.moderationStatus === 'good') adjustment += 0.05;
  adjustment += clamp((post.moderationScore || 0) * 0.01, -0.2, 0.05);
  if (post.moderationStatus === 'needs-review') adjustment -= 0.25;
  if (post.contentWarning) adjustment -= 0.03;
  return adjustment;
}

// Which lane a post belongs to, and why (the reason drives the small label
// shown on each card).
function classifyPost(post, ctx) {
  const author = String(post.author);
  const community = post.community ? String(post.community) : null;
  if (author === ctx.userId) return { lane: 'network', reason: 'own' };
  if (ctx.following.has(author)) return { lane: 'network', reason: 'following' };
  if (community && ctx.joined.has(community)) return { lane: 'network', reason: 'community' };
  return { lane: 'discovery', reason: ctx.extended.has(author) ? 'extended' : 'discovery' };
}

function networkAffinity(reason) {
  return { own: 0.5, following: 1, community: 0.8, extended: 0.35, discovery: 0 }[reason] || 0;
}

function describeSource(post, reason, parts, ctx) {
  if (reason === 'own') return 'Your post';
  if (reason === 'following') return 'From people you follow';
  if (reason === 'community') return 'From your community';
  const topTag = (post.hashtags || []).map((tag) => [tag, ctx.interests.get(tag) || 0]).sort((a, b) => b[1] - a[1])[0];
  if (topTag && topTag[1] >= 0.35) return `Because you like #${topTag[0]}`;
  if (reason === 'extended') return 'Popular with people you follow';
  if (parts.growth >= 0.5) return post.community && (ctx.communityMembers.get(String(post.community)) ?? 999) < 50 ? 'Growing community' : 'New voice worth a look';
  if (parts.hotN >= 0.6) return 'Trending on Crowdwide';
  return 'Discover';
}

function scorePost(post, ctx, view = 'for-you') {
  const config = TAB_CONFIG[view] || TAB_CONFIG['for-you'];
  const hours = ageHours(post.createdAt, ctx.now);
  const { lane, reason } = classifyPost(post, ctx);
  const points = engagementPoints(post.counts);
  const hotN = ctx.maxHot > 0 ? Math.log1p(hotValue(points, hours)) / Math.log1p(ctx.maxHot) : 0;
  const fresh = freshness(hours, config.halfLifeHours);
  const interest = interestScore(post.hashtags, ctx.interests);
  const authorInfo = ctx.authors.get(String(post.author)) || {};
  const communityMembers = post.community ? ctx.communityMembers.get(String(post.community)) : undefined;
  const growth = growthBoost({
    authorAgeDays: authorInfo.ageDays,
    authorFollowers: authorInfo.followers,
    communityMembers,
    qualifies: passesQualityBar(post)
  });
  const affinity = clamp(ctx.authorAffinity.get(String(post.author)) || 0, 0, 1);
  const net = networkAffinity(reason);
  const parts = { hotN: clamp(hotN, 0, 1), fresh, interest, growth, affinity, net };

  let score;
  if (view === 'posts-new' || view === 'articles-new') {
    // Newest first, with a head start (in hours) for new voices and for
    // topics you care about. Explainable: "as if it were posted N hours later".
    score = -hours + 3 * growth + 1.5 * interest + 10 * qualityAdjustment(post);
  } else if (view === 'posts-viral' || view === 'articles-viral') {
    score = parts.hotN * (1 + 0.5 * growth) + 0.02 * fresh + qualityAdjustment(post);
  } else {
    const jitter = (hash01(`${ctx.userId}:${post._id}:${Math.floor(ctx.now / HOUR_MS)}`) - 0.5) * 0.05;
    score = 0.28 * interest + 0.2 * net + 0.06 * affinity + 0.2 * parts.hotN + 0.2 * fresh + 0.1 * growth + qualityAdjustment(post) + jitter;
  }
  return { post, score, lane, reason, parts, source: describeSource(post, reason, parts, ctx) };
}

// Highest score first, but never more than `maxPerAuthor` posts from one
// author in a row-window and never the same author back-to-back when
// someone else is available.
function diversify(scored, { gap = 2, maxPerAuthor = 3 } = {}) {
  const remaining = scored.slice().sort((a, b) => b.score - a.score);
  const out = [];
  const counts = new Map();
  const deferred = [];
  while (remaining.length) {
    const recent = out.slice(-gap).map((item) => String(item.post.author));
    let index = remaining.findIndex((item) => {
      const author = String(item.post.author);
      return !recent.includes(author) && (counts.get(author) || 0) < maxPerAuthor;
    });
    if (index === -1) {
      // Everything left is from over-represented authors: hold them back
      // (they still appear later if the pool is otherwise empty).
      deferred.push(...remaining.splice(0, remaining.length));
      break;
    }
    const [item] = remaining.splice(index, 1);
    counts.set(String(item.post.author), (counts.get(String(item.post.author)) || 0) + 1);
    out.push(item);
  }
  return out.concat(deferred);
}

// Mixes the two lanes.
//   strict  - exactly floor(ratio * n) discovery posts among the first n
//             (so 37.5% on every page of 16); the rest come from the network.
//   floor   - order by score, but pull a discovery post forward whenever the
//             discovery share would otherwise fall below the ratio.
// If a lane runs dry the other one fills the gap, so the feed never ends
// early just because the quota cannot be met.
function mixLanes(network, discovery, { ratio = DEFAULT_DISCOVERY_RATIO, limit = 96, strict = true } = {}) {
  const net = network.slice();
  const dis = discovery.slice();
  const out = [];
  let discoveryCount = 0;
  while (out.length < limit && (net.length || dis.length)) {
    const slots = out.length + 1;
    const required = Math.floor(ratio * slots);
    let takeDiscovery;
    if (discoveryCount < required) takeDiscovery = dis.length > 0;
    else if (strict) takeDiscovery = net.length === 0;
    else if (!net.length) takeDiscovery = true;
    else if (!dis.length) takeDiscovery = false;
    else takeDiscovery = dis[0].score > net[0].score;
    const item = takeDiscovery ? dis.shift() : net.shift();
    if (takeDiscovery) discoveryCount += 1;
    out.push(item);
  }
  return out;
}

// Full pipeline: candidates in, ranked feed out.
//   candidates: [{ _id, author, community, type, hashtags, createdAt, counts,
//                  bodyLength, hasMedia, moderationStatus, moderationScore, contentWarning }]
//   ctx: { userId, now, following:Set, joined:Set, extended:Set, interests:Map,
//          authorAffinity:Map, authors:Map(id -> {ageDays, followers}),
//          communityMembers:Map(id -> members), discoveryRatio }
function rankFeed(candidates, ctx, view = 'for-you', { limit = 96 } = {}) {
  const config = TAB_CONFIG[view] || TAB_CONFIG['for-you'];
  const full = {
    now: Date.now(),
    following: new Set(),
    joined: new Set(),
    extended: new Set(),
    interests: new Map(),
    authorAffinity: new Map(),
    authors: new Map(),
    communityMembers: new Map(),
    ...ctx
  };
  const ratio = resolveDiscoveryRatio(full.discoveryRatio);
  const seen = new Set();
  const unique = candidates.filter((post) => {
    const id = String(post._id);
    if (seen.has(id)) return false;
    seen.add(id);
    return !config.types || config.types.includes(post.type);
  });
  const maxHot = unique.reduce((max, post) => Math.max(max, hotValue(engagementPoints(post.counts), ageHours(post.createdAt, full.now))), 0);
  full.maxHot = maxHot;

  let scored = unique.map((post) => scorePost(post, full, view));
  if (view === 'my-community') {
    // This tab is about communities: the network lane is joined communities
    // only, and discovery is limited to posts that live in a community.
    scored = scored
      .filter((item) => Boolean(item.post.community))
      .map((item) => ({ ...item, lane: full.joined.has(String(item.post.community)) ? 'network' : 'discovery' }));
  }
  if (view === 'posts-viral' || view === 'articles-viral') {
    // "Viral" needs some traction; posts with none only fill in when the
    // platform is too quiet for a real ranking.
    const withTraction = scored.filter((item) => engagementPoints(item.post.counts) >= 2);
    if (withTraction.length >= PAGE_SIZE) scored = withTraction;
  }
  const networkLane = diversify(scored.filter((item) => item.lane === 'network'));
  const discoveryLane = diversify(scored.filter((item) => item.lane === 'discovery'));
  return mixLanes(networkLane, discoveryLane, { ratio, limit, strict: config.mixing === 'strict' });
}

module.exports = {
  PAGE_SIZE,
  DEFAULT_DISCOVERY_RATIO,
  MIN_DISCOVERY_RATIO,
  MAX_DISCOVERY_RATIO,
  TAB_CONFIG,
  TABS,
  ENGAGEMENT_WEIGHTS,
  isFeedTab,
  resolveDiscoveryRatio,
  hash01,
  ageHours,
  engagementPoints,
  hotValue,
  freshness,
  interestScore,
  buildInterestMap,
  growthBoost,
  passesQualityBar,
  qualityAdjustment,
  classifyPost,
  scorePost,
  diversify,
  mixLanes,
  rankFeed
};
