'use strict';
// Static-asset helpers: versioned URLs (safe to cache for a year) and CSS bundles (fewer requests).
//
// The stylesheets used to be 14 separate render-blocking requests. In production they are concatenated, in
// exactly the same order as before, into three files, so the cascade (and therefore the look) is unchanged.
// Every local script/stylesheet URL gets ?v=<content hash>; a changed file gets a new URL, so browsers can
// keep the old one for a year without ever showing stale CSS/JS.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

// Order matters: this is the original <link> order from partials/head.ejs.
// community-workspace.css is only loaded on community pages, between the two bundles.
const BUNDLES = {
  base: ['style', 'responsive-media', 'media-player', 'admin-panel', 'responsive-layout', 'chat-ui', 'code-blocks', 'modern-ui', 'surveys', 'partnerships'],
  polish: ['spacing', 'minimal', 'polish', 'reading']
};

const enabled = () => process.env.ASSET_BUNDLE === 'on' || (process.env.ASSET_BUNDLE !== 'off' && process.env.NODE_ENV === 'production');

const bundleCache = new Map();
function buildBundle(name) {
  if (bundleCache.has(name)) return bundleCache.get(name);
  const files = BUNDLES[name];
  if (!files) return null;
  const text = files.map((file) => `/* ${file}.css */\n${fs.readFileSync(path.join(PUBLIC_DIR, 'css', `${file}.css`), 'utf8')}`).join('\n');
  const version = crypto.createHash('sha1').update(text).digest('hex').slice(0, 10);
  const entry = { text, version };
  bundleCache.set(name, entry);
  return entry;
}

const versionCache = new Map();
function versionOf(urlPath) {
  if (versionCache.has(urlPath)) return versionCache.get(urlPath);
  let version = '';
  try {
    const file = path.join(PUBLIC_DIR, urlPath.replace(/^\//, ''));
    if (file.startsWith(PUBLIC_DIR)) version = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 10);
  } catch (error) { /* not in /public (e.g. /vendor): leave unversioned */ }
  versionCache.set(urlPath, version);
  return version;
}

// asset('/js/app.js') -> '/js/app.js?v=ab12cd34ef' (production), unchanged otherwise.
function asset(urlPath) {
  if (!enabled() || /[?#]/.test(urlPath)) return urlPath;
  const version = versionOf(urlPath);
  return version ? `${urlPath}?v=${version}` : urlPath;
}

// Stylesheet URLs for the head: the bundles when enabled, otherwise null (head.ejs falls back to the single files).
function cssBundleUrls() {
  if (!enabled()) return null;
  return Object.fromEntries(Object.keys(BUNDLES).map((name) => [name, `/css/bundle-${name}.css?v=${buildBundle(name).version}`]));
}

// Express handler for /css/bundle-<name>.css
function serveBundle(req, res, next) {
  const match = /^\/css\/bundle-([a-z]+)\.css$/.exec(req.path);
  if (!match || !enabled()) return next();
  const bundle = buildBundle(match[1]);
  if (!bundle) return next();
  res.type('text/css');
  res.setHeader('Cache-Control', req.query.v === bundle.version ? 'public, max-age=31536000, immutable' : 'no-cache');
  res.setHeader('ETag', `"${bundle.version}"`);
  if (req.headers['if-none-match'] === `"${bundle.version}"`) return res.status(304).end();
  return res.send(bundle.text);
}

// Long-lived caching for versioned asset URLs; images (rarely change) get a week; everything else revalidates.
function cacheHeaders(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (/^\/(css|js|vendor)\//.test(req.path) && /^[0-9a-f]{10}$/.test(String(req.query.v || ''))) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } else if (/^\/images\//.test(req.path)) {
    res.setHeader('Cache-Control', 'public, max-age=604800');
  }
  return next();
}

module.exports = { asset, cssBundleUrls, serveBundle, cacheHeaders, BUNDLES, enabled };
