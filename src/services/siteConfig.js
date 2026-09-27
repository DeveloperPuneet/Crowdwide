// Small cached reader for the SiteSetting singleton. Word limits, the
// default suspension length, and similar admin-controlled values get read
// on almost every post/comment write, so this avoids a database round trip
// per request while still picking up admin changes within a few seconds.
const SiteSetting = require('../models/SiteSetting');

const CACHE_TTL_MS = 30 * 1000;
let cached = null;
let cachedAt = 0;

async function getSiteConfig() {
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached;
  const settings = await SiteSetting.getSingleton();
  cached = settings;
  cachedAt = Date.now();
  return cached;
}

// Called by the admin controller right after a save so the new values take
// effect immediately instead of waiting out the cache TTL.
function clearSiteConfigCache() {
  cached = null;
  cachedAt = 0;
}

async function getWordLimits() {
  const settings = await getSiteConfig();
  return {
    post: settings.postWordLimit || 60,
    article: settings.articleWordLimit || 300,
    poll: settings.postWordLimit || 60
  };
}

module.exports = { getSiteConfig, clearSiteConfigCache, getWordLimits };
