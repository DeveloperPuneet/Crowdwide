const SearchEvent = require('../models/SearchEvent');
const Community = require('../models/Community');
const { getTrendingHashtags } = require('./discovery');
const logger = require('./logger');

const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = null;

// Turns whatever was typed into { key, label }, or null when it should never
// be recorded or shown (too short/long, emails, phone numbers, links).
function normalizeQuery(input) {
  const label = String(input || '').replace(/\s+/g, ' ').trim();
  if (label.length < 2 || label.length > 60) return null;
  if (!/[\p{L}\p{N}]/u.test(label)) return null;
  if (/\S+@\S+\.\S+/.test(label)) return null; // email address
  if (/(https?:\/\/|www\.)/i.test(label)) return null; // link
  if (/\d{6,}/.test(label.replace(/[\s()+.-]/g, ''))) return null; // phone / id-like numbers
  return { key: label.toLowerCase(), label };
}

function hrefFor(label) {
  return `/search?q=${encodeURIComponent(label)}`;
}

function kindOf(label) {
  if (label.startsWith('#')) return 'hashtag';
  if (label.startsWith('@')) return 'person';
  return 'query';
}

// Fire-and-forget from the search handler: a failure here must never break
// the search itself.
async function recordSearch({ userId, query, hits = 0 }) {
  const normalized = normalizeQuery(query);
  if (!normalized || !userId) return false;
  try {
    await SearchEvent.create({ key: normalized.key, label: normalized.label, user: userId, hits });
    return true;
  } catch (error) {
    logger.warn('Could not record search event', error);
    return false;
  }
}

async function rankQueries({ days, minUsers, limit, now }) {
  const since = new Date(now - days * DAY_MS);
  const rows = await SearchEvent.aggregate([
    { $match: { createdAt: { $gte: since }, hits: { $gt: 0 } } },
    { $sort: { createdAt: 1 } }, // so $last below means "most recent spelling"
    { $group: { _id: { key: '$key', user: '$user' }, searches: { $sum: 1 }, label: { $last: '$label' }, last: { $max: '$createdAt' } } },
    { $group: { _id: '$_id.key', people: { $sum: 1 }, searches: { $sum: '$searches' }, label: { $last: '$label' }, last: { $max: '$last' } } },
    { $match: { people: { $gte: minUsers } } },
    { $sort: { people: -1, searches: -1, last: -1 } },
    { $limit: limit }
  ]);
  return rows.map((row) => ({ label: row.label, href: hrefFor(row.label), kind: kindOf(row.label), people: row.people, searches: row.searches, suggested: false }));
}

// Popular searches = what people actually typed (queries, @people and
// #hashtags together), ranked by how many different members searched for it
// recently. Until enough real searches exist, the list is topped up with
// clearly-marked suggestions so the section is never empty.
async function getPopularSearches({ limit = 8, days = 14, now = Date.now(), env = process.env } = {}) {
  if (cache && now - cache.at < CACHE_TTL_MS && cache.limit === limit) return cache.value;
  const minUsers = Math.max(1, Number.parseInt(env.POPULAR_SEARCH_MIN_USERS, 10) || 2);
  let queries = [];
  try {
    queries = await rankQueries({ days, minUsers, limit, now });
  } catch (error) {
    logger.warn('Could not load popular searches', error);
  }
  const items = queries.slice();
  if (items.length < limit) {
    const taken = new Set(items.map((item) => item.label.toLowerCase()));
    try {
      const [communities, tags] = await Promise.all([
        Community.find({ isPrivate: false }).sort({ membersCount: -1, createdAt: -1 }).limit(limit).select('name').lean(),
        getTrendingHashtags(limit)
      ]);
      const suggestions = [
        ...communities.map((community) => ({ label: community.name, kind: 'query' })),
        ...tags.map(({ tag }) => ({ label: `#${tag}`, kind: 'hashtag' }))
      ];
      // Interleave so a few queries and a few tags both show up.
      suggestions.forEach((suggestion) => {
        if (items.length >= limit || taken.has(suggestion.label.toLowerCase())) return;
        taken.add(suggestion.label.toLowerCase());
        items.push({ ...suggestion, href: hrefFor(suggestion.label), people: 0, searches: 0, suggested: true });
      });
    } catch (error) {
      logger.warn('Could not build suggested searches', error);
    }
  }
  cache = { at: now, limit, value: items };
  return items;
}

function clearPopularSearchesCache() {
  cache = null;
}

module.exports = { normalizeQuery, recordSearch, getPopularSearches, clearPopularSearchesCache, hrefFor, kindOf };
