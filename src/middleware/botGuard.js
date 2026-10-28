// Bot guard: spots floods, scanners and rate-limit abuse and blocks the address
// for 24 hours (BOT_BLOCK_HOURS). Everything is counted in memory, so normal
// traffic costs no database work; only a block itself is written (BlockedIp),
// so it survives a restart on free-tier hosting.
//
// Signals (each one blocks):
//   burst       far more requests in 10 seconds than any person makes
//   sustained   a steady flood over five minutes
//   probing     two hits on paths only vulnerability scanners ask for (/.env, /wp-login.php ...)
//   scanner-ua  a known scanner / exploit tool in the User-Agent
//   rate-abuse  keeps hammering after the rate limiter already said "slow down"
//   404-flood   dozens of missing pages in two minutes (directory guessing)
//   fixed-rhythm  the same page opened again and again at a steady interval (view-count bots)
//   url-variants  one page requested with many different ?query strings (the "different link" trick)
//   post-flood  many form posts without being signed in (sign-up / login spam)
//
// Safety rails: private and loopback addresses are never blocked (a wrong
// TRUST_PROXY_HOPS would otherwise make the proxy's own address look like one
// giant bot), signed-in users and search-engine crawlers get higher limits,
// BOT_GUARD_ALLOWLIST exempts addresses, and BOT_GUARD=off turns it all off.
const logger = require('../services/logger');

const HOUR = 60 * 60 * 1000;
const WINDOW = { burst: 10 * 1000, sustained: 5 * 60 * 1000, probe: 30 * 60 * 1000, limited: 10 * 60 * 1000, missing: 2 * 60 * 1000, posts: 60 * 1000 };
const LIMITS = { burst: 100, sustained: 500, probe: 2, limited: 20, missing: 40, posts: 25, variants: 10, rhythm: 8 };
const MAX_TRACKED = 50000;
// View-inflation bots: they hit the same post/profile over and over, often with a different
// ?query each time so every link looks new. People do not reload one page on a metronome.
const VIEW_PATH = /^\/(?:posts|u|c|communities)\/[^/]+\/?$/i;
const VIEW = { window: 15 * 60 * 1000, variants: 10, rhythm: 8 };

const PROBE_PATHS = /^\/(?:\.(?:env|git|svn|aws|ssh|ds_store|htaccess|htpasswd)\b|wp-(?:login|admin|content|includes|config)|wordpress\b|xmlrpc\.php|phpmyadmin|pma\b|myadmin|adminer|administrator\b|cgi-bin|vendor\/phpunit|actuator|server-status|config\.(?:php|json|yml|yaml)|backup\.(?:sql|zip|tar)|id_rsa|boaform|solr|jenkins|console\b|manager\/html|shell\b|eval-stdin\.php)/i;
const SCANNER_UA = /\b(?:sqlmap|nikto|nmap|masscan|zgrab|acunetix|nessus|openvas|dirbuster|gobuster|wpscan|nuclei|havij|w3af|burpcollaborator|jaeles|feroxbuster|fuzz faster)\b/i;
const GOOD_CRAWLER = /\b(?:Googlebot|bingbot|DuckDuckBot|Applebot|Slurp|YandexBot|facebookexternalhit|Twitterbot|LinkedInBot|WhatsApp|Discordbot|TelegramBot)\b/i;
const EXEMPT_POST = /^\/(?:unsubscribe|webhooks?)\b/;

const blocked = new Map(); // ip -> { until, reason }
const seen = new Map(); // ip -> counters
let model = null;
let refreshTimer = null;

const enabled = () => String(process.env.BOT_GUARD || 'on').toLowerCase() !== 'off';
const blockMs = () => Math.max(1, Number(process.env.BOT_BLOCK_HOURS) || 24) * HOUR;
const allowlist = () => new Set(String(process.env.BOT_GUARD_ALLOWLIST || '').split(',').map((entry) => normalizeIp(entry.trim())).filter(Boolean));

// IPv4-mapped IPv6 becomes plain IPv4; other IPv6 addresses are grouped by their /64
// so rotating the last 64 bits (which one customer controls) cannot dodge a block.
function normalizeIp(raw) {
  let ip = String(raw || '').trim().toLowerCase();
  if (!ip) return '';
  ip = ip.replace(/^\[|\]$/g, '').replace(/%.+$/, '');
  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return mapped[1];
  if (ip.includes(':')) {
    const [head, tail = ''] = ip.split('::');
    const front = head ? head.split(':') : [];
    const back = tail ? tail.split(':') : [];
    const full = ip.includes('::') ? [...front, ...Array(Math.max(0, 8 - front.length - back.length)).fill('0'), ...back] : front;
    if (full.length !== 8) return ip;
    return `${full.slice(0, 4).map((part) => part.replace(/^0+(?=.)/, '')).join(':')}::/64`;
  }
  return ip;
}

function isPrivate(raw) {
  let ip = String(raw || '').trim().toLowerCase();
  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) ip = mapped[1];
  if (!ip) return true;
  if (ip.includes(':')) return ip === '::1' || ip === '::' || /^(?:fc|fd|fe80)/.test(ip);
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return true;
  const [a, b] = parts;
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

const trim = (list, now, span) => { while (list.length && now - list[0] > span) list.shift(); };

function stateFor(ip, now) {
  let state = seen.get(ip);
  if (!state) {
    if (seen.size >= MAX_TRACKED) seen.delete(seen.keys().next().value);
    state = { burst: [], sustained: [], probes: [], limited: [], missing: [], posts: [], views: new Map(), last: now };
    seen.set(ip, state);
  }
  state.last = now;
  return state;
}


// Records a page view and reports 'url-variants' / 'fixed-rhythm' when it looks automated.
function viewSignal(state, req, now) {
  if (req.method !== 'GET' || !VIEW_PATH.test(req.path) || req.xhr) return '';
  const key = req.path.toLowerCase().replace(/\/$/, '');
  if (state.views.size > 200) state.views.delete(state.views.keys().next().value);
  let entry = state.views.get(key);
  if (!entry) { entry = { times: [], queries: new Set() }; state.views.set(key, entry); }
  entry.times.push(now); trim(entry.times, now, VIEW.window);
  if (!entry.times.length || entry.times.length === 1) entry.queries.clear();
  const query = String(req.originalUrl || '').split('?')[1] || '';
  if (query) entry.queries.add(query.slice(0, 200));
  if (entry.queries.size >= LIMITS.variants) return 'url-variants';
  const times = entry.times;
  if (times.length > LIMITS.rhythm + 1) {
    const gaps = [];
    for (let i = times.length - LIMITS.rhythm; i < times.length; i += 1) gaps.push(times[i] - times[i - 1]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const dev = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
    if (mean >= 1500 && mean <= 5 * 60 * 1000 && dev / mean < 0.08) return 'fixed-rhythm';
  }
  return '';
}

function getBlockModel() {
  if (model === null) {
    try { model = require('../models/BlockedIp'); } catch (error) { model = false; }
  }
  return model || null;
}

function isBlocked(ip, now = Date.now()) {
  const entry = blocked.get(ip);
  if (!entry) return null;
  if (entry.until <= now) { blocked.delete(ip); return null; }
  return entry;
}

function block(ip, reason, req, now = Date.now()) {
  if (blocked.has(ip)) return;
  const until = now + blockMs();
  blocked.set(ip, { until, reason });
  seen.delete(ip);
  const meta = { ip, reason, path: String(req?.originalUrl || req?.url || '').slice(0, 200), userAgent: String(req?.get?.('user-agent') || '').slice(0, 300) };
  logger.warn('Bot guard blocked an address', { ...meta, until: new Date(until).toISOString() });
  const Model = getBlockModel();
  if (!Model) return;
  Promise.resolve(Model.findOneAndUpdate(
    { ip },
    { $set: { reason, lastPath: meta.path, userAgent: meta.userAgent, blockedAt: new Date(now), expiresAt: new Date(until) }, $inc: { hits: 1 } },
    { upsert: true }
  )).catch((error) => logger.error('Bot guard could not save a block', error));
}

function respondBlocked(req, res, entry) {
  const retry = Math.max(1, Math.ceil((entry.until - Date.now()) / 1000));
  res.set('Retry-After', String(retry));
  res.set('Cache-Control', 'no-store');
  const message = 'Your connection was blocked for 24 hours because it sent automated or excessive requests. If you believe this is a mistake, please contact support.';
  const accept = req.get('accept') || '';
  const wantsJson = req.xhr || req.get('x-requested-with') === 'XMLHttpRequest' || (/json/.test(accept) && !/html/.test(accept)) || /^\/api\//.test(req.path);
  if (wantsJson) return res.status(403).json({ error: message });
  return res.status(403).type('text/plain').send(message);
}

// Cheap first check, mounted before everything else: a blocked address gets a 403 and nothing more.
function gate(req, res, next) {
  if (!enabled() || blocked.size === 0) return next();
  const ip = normalizeIp(req.ip);
  const entry = ip && !allowlist().has(ip) ? isBlocked(ip) : null;
  if (!entry) return next();
  return respondBlocked(req, res, entry);
}

// Counts requests and blocks on a signal. Mounted after the session so signed-in users get more room.
function track(req, res, next) {
  if (!enabled()) return next();
  const ip = normalizeIp(req.ip);
  if (!ip || isPrivate(req.ip) || allowlist().has(ip)) return next();
  if (req.path === '/health' || req.path.startsWith('/media/')) return next();
  const now = Date.now();
  const agent = String(req.get('user-agent') || '');
  if (SCANNER_UA.test(agent)) { block(ip, 'scanner-ua', req, now); return respondBlocked(req, res, isBlocked(ip, now) || { until: now + blockMs() }); }

  const signedIn = Boolean(req.session?.user);
  const factor = GOOD_CRAWLER.test(agent) ? 3 : signedIn ? 2 : 1;
  const state = stateFor(ip, now);
  let reason = '';

  if (PROBE_PATHS.test(req.path)) {
    state.probes.push(now);
    trim(state.probes, now, WINDOW.probe);
    if (state.probes.length >= LIMITS.probe) reason = 'probing';
  }
  state.burst.push(now); trim(state.burst, now, WINDOW.burst);
  state.sustained.push(now); trim(state.sustained, now, WINDOW.sustained);
  if (!reason && state.burst.length > LIMITS.burst * factor) reason = 'burst';
  if (!reason && state.sustained.length > LIMITS.sustained * factor) reason = 'sustained';
  if (!reason && req.method === 'POST' && !signedIn && !EXEMPT_POST.test(req.path)) {
    state.posts.push(now); trim(state.posts, now, WINDOW.posts);
    if (state.posts.length > LIMITS.posts) reason = 'post-flood';
  }

  if (!reason && !GOOD_CRAWLER.test(agent)) reason = viewSignal(state, req, now);

  if (reason) {
    block(ip, reason, req, now);
    return respondBlocked(req, res, isBlocked(ip, now) || { until: now + blockMs() });
  }

  res.on('finish', () => {
    if (res.statusCode !== 429 && res.statusCode !== 404) return;
    const at = Date.now();
    const current = seen.get(ip) || stateFor(ip, at);
    if (res.statusCode === 429) {
      current.limited.push(at); trim(current.limited, at, WINDOW.limited);
      if (current.limited.length >= LIMITS.limited) block(ip, 'rate-abuse', req, at);
    } else if (!GOOD_CRAWLER.test(agent)) {
      current.missing.push(at); trim(current.missing, at, WINDOW.missing);
      if (current.missing.length >= LIMITS.missing) block(ip, '404-flood', req, at);
    }
  });
  return next();
}

// Loads still-active blocks (so a restart does not free a bot) and re-syncs now and then,
// which also picks up unblocks made by an admin on another instance.
async function load() {
  const Model = getBlockModel();
  if (!Model) return 0;
  const rows = await Model.find({ expiresAt: { $gt: new Date() } }).select('ip reason expiresAt').lean();
  const fresh = new Map(rows.map((row) => [row.ip, { until: new Date(row.expiresAt).getTime(), reason: row.reason }]));
  for (const ip of [...blocked.keys()]) if (!fresh.has(ip)) blocked.delete(ip);
  for (const [ip, entry] of fresh) blocked.set(ip, entry);
  return rows.length;
}

function init() {
  if (!enabled() || refreshTimer) return;
  load().catch((error) => logger.error('Bot guard could not load blocks', error));
  refreshTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, state] of seen) if (now - state.last > WINDOW.sustained) seen.delete(ip);
    load().catch((error) => logger.error('Bot guard could not refresh blocks', error));
  }, 5 * 60 * 1000);
  refreshTimer.unref?.();
}

async function unblock(ip) {
  const key = normalizeIp(ip);
  blocked.delete(key);
  seen.delete(key);
  const Model = getBlockModel();
  if (Model) await Model.deleteOne({ ip: key });
  return key;
}

function reset() { blocked.clear(); seen.clear(); }

module.exports = { gate, track, init, load, unblock, block, isBlocked, normalizeIp, isPrivate, reset, LIMITS, PROBE_PATHS, SCANNER_UA, _blocked: blocked };
