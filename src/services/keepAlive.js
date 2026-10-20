// Free-tier keep-alive.
//
// Free hosts (Render, Koyeb, Railway trial, run.place, ...) put a service to
// sleep after ~15 minutes without inbound HTTP traffic, and the next visitor
// then waits 30-60 seconds for a cold start. A node-cron job that requests
// this app's own public /health URL every few minutes counts as inbound
// traffic (the request goes out to the public URL and comes back in through
// the host's proxy), so the instance never reaches the idle threshold.
//
// It also pings MongoDB on the same tick so an idle Atlas connection is
// noticed and re-established before a real user hits it.
//
// Configuration (all optional):
//   KEEP_ALIVE_ENABLED   "true" / "false". Default: on only in production
//                        when a public (non-localhost) URL is known.
//   KEEP_ALIVE_URL       URL to ping. Default: RENDER_EXTERNAL_URL, then APP_URL.
//   KEEP_ALIVE_CRON      Cron expression. Default every 10 minutes.
//   KEEP_ALIVE_TIMEOUT_MS  Request timeout. Default 20000.
//   KEEP_ALIVE_PRESENCE_SECONDS  While a real visitor has made a request this recently,
//                        the ping is skipped (their traffic already keeps the host
//                        awake) and it resumes by itself once they have gone. Default
//                        120. Keep it well under the host's idle limit (~15 min).

const cron = require('node-cron');
const logger = require('./logger');

const DEFAULT_CRON = '*/10 * * * *';
const DEFAULT_TIMEOUT_MS = 20000;

function isLocalHost(hostname = '') {
  return ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(hostname.toLowerCase());
}

// Returns the health-check URL to ping, or null when there is no usable
// public address (in which case pinging would be pointless).
function resolveTarget(env = process.env) {
  const raw = (env.KEEP_ALIVE_URL || env.RENDER_EXTERNAL_URL || env.APP_URL || '').trim();
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch (error) { return null; }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  if (isLocalHost(url.hostname) && env.KEEP_ALIVE_ENABLED !== 'true') return null;
  if (!/\/health\/?$/.test(url.pathname)) url.pathname = `${url.pathname.replace(/\/$/, '')}/health`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function isEnabled(env = process.env) {
  const flag = String(env.KEEP_ALIVE_ENABLED || '').toLowerCase();
  if (flag === 'false' || flag === '0' || flag === 'off') return false;
  if (flag === 'true' || flag === '1' || flag === 'on') return true;
  if (String(env.APP_ENV || '').toLowerCase() === 'staging') return false;
  return env.NODE_ENV === 'production';
}

function resolveSchedule(env = process.env, validate = cron.validate) {
  const wanted = (env.KEEP_ALIVE_CRON || '').trim();
  if (wanted && validate(wanted)) return wanted;
  if (wanted) logger.warn(`KEEP_ALIVE_CRON "${wanted}" is not a valid cron expression; using ${DEFAULT_CRON}.`);
  return DEFAULT_CRON;
}

async function pingOnce(target, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(target, {
      method: 'GET',
      headers: { 'user-agent': 'crowdwide-keepalive/1.0', accept: 'application/json' },
      signal: controller.signal
    });
    return { ok: response.status < 500, status: response.status, ms: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, status: 0, ms: Date.now() - startedAt, error: error.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function pingDatabase(mongoose) {
  try {
    if (mongoose?.connection?.readyState !== 1 || !mongoose.connection.db) return { ok: false, skipped: true };
    await mongoose.connection.db.command({ ping: 1 });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// ---- visitor presence --------------------------------------------------------
// Any real request (not our own health ping) counts as "someone is here".
const DEFAULT_PRESENCE_SECONDS = 120;
let lastVisitAt = 0;

function recordVisit(now = Date.now()) { lastVisitAt = now; }
function resetPresence() { lastVisitAt = 0; }

function presenceWindowMs(env = process.env) {
  const seconds = Number(env.KEEP_ALIVE_PRESENCE_SECONDS);
  return (Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_PRESENCE_SECONDS) * 1000;
}

function visitorsPresent(now = Date.now(), env = process.env) {
  const windowMs = presenceWindowMs(env);
  return windowMs > 0 && lastVisitAt > 0 && now - lastVisitAt < windowMs;
}

// Express middleware: records real visits. Health checks and our own pings never count.
function presenceMiddleware(req, res, next) {
  if (req.path !== '/health' && !String(req.get('user-agent') || '').startsWith('crowdwide-keepalive')) recordVisit();
  next();
}

let activeTask = null;

function startKeepAlive({ env = process.env, fetchImpl, cronImpl = cron, mongoose = require('mongoose') } = {}) {
  if (activeTask) return activeTask;
  if (!isEnabled(env)) {
    logger.info('Keep-alive cron is off (set KEEP_ALIVE_ENABLED=true to force it on).');
    return null;
  }
  const target = resolveTarget(env);
  if (!target) {
    logger.info('Keep-alive cron not started: no public APP_URL / KEEP_ALIVE_URL to ping.');
    return null;
  }
  const schedule = resolveSchedule(env, cronImpl.validate);
  const timeoutMs = Number(env.KEEP_ALIVE_TIMEOUT_MS) > 0 ? Number(env.KEEP_ALIVE_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  let failures = 0;
  let paused = false;

  const tick = async () => {
    // Someone is on the site, so their own requests keep the host awake: do nothing, and carry on again once they leave.
    if (visitorsPresent(Date.now(), env)) {
      if (!paused) { paused = true; logger.info('Keep-alive paused: visitors are on the site.'); }
      return { skipped: 'visitors-present' };
    }
    if (paused) { paused = false; logger.info('Keep-alive resumed: no visitors for a while.'); }
    const [web, db] = await Promise.all([pingOnce(target, { fetchImpl, timeoutMs }), pingDatabase(mongoose)]);
    if (web.ok) {
      // Only speak up when things change - a healthy ping every 10 minutes
      // would otherwise be ~144 useless log lines a day.
      if (failures) logger.info(`Keep-alive recovered after ${failures} failed ping${failures === 1 ? '' : 's'} (${web.ms}ms).`);
      failures = 0;
    } else {
      failures += 1;
      logger.warn(`Keep-alive ping failed (${failures} in a row): ${web.error || `HTTP ${web.status}`}`, { target });
    }
    if (!db.ok && !db.skipped) logger.warn('Keep-alive MongoDB ping failed.', { error: db.error });
    return { web, db };
  };

  activeTask = cronImpl.schedule(schedule, () => { tick().catch((error) => logger.warn('Keep-alive tick crashed', error)); });
  activeTask.runNow = tick;
  logger.info(`Keep-alive cron started (${schedule}) -> ${target}`);
  return activeTask;
}

function stopKeepAlive() {
  if (!activeTask) return;
  try { activeTask.stop(); } catch (error) { /* already stopped */ }
  activeTask = null;
}

module.exports = { recordVisit, resetPresence, visitorsPresent, presenceMiddleware, presenceWindowMs, startKeepAlive, stopKeepAlive, resolveTarget, resolveSchedule, isEnabled, pingOnce, pingDatabase, DEFAULT_CRON };
