// GIF search for chat, group chat and comments.
//
// Provider: GIPHY (set GIPHY_API_KEY). Google shut the Tenor API down on
// 30 June 2026, so Tenor is not an option any more.
//
// The browser never talks to GIPHY directly: it calls /gifs/search on this
// server, which holds the API key, caches answers (GIPHY's free tier is
// rate-limited) and returns a small, normalized shape. When a GIF is sent, the
// server checks that its URL really points at GIPHY's CDN before storing it,
// so nobody can attach an arbitrary remote image through the GIF fields.

const logger = require('./logger');

const API_BASE = 'https://api.giphy.com/v1/gifs';
const PAGE_SIZE = 24;
const CACHE_TTL_MS = 5 * 60 * 1000;
const TRENDING_TTL_MS = 15 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;
const ALLOWED_HOSTS = [/^media\d*\.giphy\.com$/i, /^i\.giphy\.com$/i];
const RATINGS = ['g', 'pg', 'pg-13', 'r'];

const cache = new Map();

function gifsEnabled(env = process.env) {
  return Boolean((env.GIPHY_API_KEY || '').trim());
}

function isAllowedGifUrl(value) {
  if (typeof value !== 'string' || value.length > 600) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && ALLOWED_HOSTS.some((pattern) => pattern.test(url.hostname));
  } catch (error) {
    return false;
  }
}

function toDimension(value) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) && number > 0 && number <= 4000 ? number : undefined;
}

// Validates the gif fields of a chat message / comment. Returns the clean
// object to store, or null when there is no (valid) GIF.
function sanitizeGif(input = {}) {
  const url = String(input.url || input.gifUrl || '').trim();
  if (!isAllowedGifUrl(url)) return null;
  const previewCandidate = String(input.preview || input.gifPreview || '').trim();
  return {
    url,
    preview: isAllowedGifUrl(previewCandidate) ? previewCandidate : url,
    title: String(input.title || input.gifTitle || '').replace(/\s+/g, ' ').trim().slice(0, 100),
    width: toDimension(input.width || input.gifWidth),
    height: toDimension(input.height || input.gifHeight)
  };
}

// Pulls the GIF out of a request body (form fields named gifUrl, gifPreview...).
function gifFromBody(body = {}) {
  if (!body.gifUrl) return null;
  return sanitizeGif({ url: body.gifUrl, preview: body.gifPreview, title: body.gifTitle, width: body.gifWidth, height: body.gifHeight });
}

function normalizeGiphyItem(item) {
  const images = item?.images || {};
  const main = images.fixed_width || images.downsized || images.original;
  const small = images.fixed_width_small || images.fixed_width || main;
  if (!main?.url || !isAllowedGifUrl(main.url)) return null;
  return {
    id: String(item.id),
    title: String(item.title || '').slice(0, 100),
    url: main.url,
    preview: small?.url && isAllowedGifUrl(small.url) ? small.url : main.url,
    width: toDimension(main.width),
    height: toDimension(main.height)
  };
}

function remember(key, value, ttl) {
  if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expires: Date.now() + ttl });
}

async function searchGifs({ q = '', offset = 0, limit = PAGE_SIZE, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (!gifsEnabled(env)) {
    const error = new Error('GIF search is not configured.');
    error.code = 'GIF_NOT_CONFIGURED';
    throw error;
  }
  const query = String(q || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const start = Math.max(0, Math.min(Number.parseInt(offset, 10) || 0, 500));
  const count = Math.max(1, Math.min(Number.parseInt(limit, 10) || PAGE_SIZE, 30));
  const rating = RATINGS.includes(String(env.GIF_RATING || '').toLowerCase()) ? String(env.GIF_RATING).toLowerCase() : 'pg-13';
  const key = `${query.toLowerCase()}|${start}|${count}|${rating}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  const params = new URLSearchParams({ api_key: env.GIPHY_API_KEY.trim(), limit: String(count), offset: String(start), rating, bundle: 'messaging_non_clips' });
  if (query) { params.set('q', query); params.set('lang', 'en'); }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetchImpl(`${API_BASE}/${query ? 'search' : 'trending'}?${params}`, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) {
      const error = new Error(`GIF provider answered ${response.status}`);
      error.code = response.status === 429 ? 'GIF_RATE_LIMITED' : 'GIF_PROVIDER_ERROR';
      throw error;
    }
    const payload = await response.json();
    const results = (payload.data || []).map(normalizeGiphyItem).filter(Boolean);
    const total = Number(payload.pagination?.total_count) || 0;
    const next = start + (payload.data || []).length < total ? start + (payload.data || []).length : null;
    const value = { results, next };
    remember(key, value, query ? CACHE_TTL_MS : TRENDING_TTL_MS);
    return value;
  } catch (error) {
    if (!error.code) {
      error.code = error.name === 'AbortError' ? 'GIF_TIMEOUT' : 'GIF_PROVIDER_ERROR';
      logger.warn('GIF search failed', { code: error.code, message: error.message });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function clearGifCache() {
  cache.clear();
}

module.exports = { gifsEnabled, isAllowedGifUrl, sanitizeGif, gifFromBody, normalizeGiphyItem, searchGifs, clearGifCache, PAGE_SIZE };
