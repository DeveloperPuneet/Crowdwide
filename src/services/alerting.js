// Baseline "monitoring/alerts": not a replacement for a real APM/error
// tracker (Sentry, Datadog, etc. - see Known Gaps in todo.txt), but a
// genuine, working safety net that costs nothing extra to run: when
// something serious breaks, one admin gets an email instead of the failure
// only ever showing up in logs nobody is watching in real time.
//
// Deliberately narrow trigger surface: this is called from exactly one
// place, the global error-handling middleware in app.js, for actual
// unhandled request failures (5xx). It is NOT wired into every
// logger.error() call - most of those (a failed push notification, a
// down mail provider) are expected, already-handled-gracefully conditions
// that would turn "alerts" into noise nobody reads. Paging on rare,
// unhandled crashes is the useful signal; paging on every already-logged
// hiccup is not.

const logger = require('./logger');

const ALERT_COOLDOWN_MS = 15 * 60 * 1000;
const lastAlertAt = new Map();

function isConfigured() {
  return Boolean(process.env.ADMIN_ALERT_EMAIL);
}

// Groups repeats of "the same thing keeps breaking" into one alert per
// cooldown window, keyed by a caller-supplied signature (e.g. the error
// message) - so one bad deploy that fails on every request sends one
// email, not one per request.
function shouldAlert(signature) {
  const last = lastAlertAt.get(signature);
  if (last && Date.now() - last < ALERT_COOLDOWN_MS) return false;
  lastAlertAt.set(signature, Date.now());
  return true;
}

async function alertOnCriticalError(error, context = {}) {
  if (!isConfigured()) return;
  const signature = `${context.route || 'unknown-route'}:${error.message}`;
  if (!shouldAlert(signature)) return;

  // Requiring mailer here (rather than at module load) avoids a require
  // cycle risk if mailer ever needs alerting in the future.
  const { sendSecurityAlert } = require('./mailer');
  try {
    await sendSecurityAlert({ email: process.env.ADMIN_ALERT_EMAIL }, {
      subject: `Crowdwide error: ${error.message}`.slice(0, 200),
      heading: 'Unhandled server error',
      message: `${error.message}\n\nRoute: ${context.route || 'unknown'}\nTime: ${new Date().toISOString()}\n\n${error.stack || ''}`
    });
  } catch (sendError) {
    // sendSecurityAlert already swallows mail-provider failures internally
    // (see mailer.js) so this catch is only for anything unexpected in the
    // alerting path itself - never let alerting be a second point of
    // failure on top of the error it's trying to report.
    logger.error('Failed to send critical-error alert email', sendError);
  }
}

module.exports = { alertOnCriticalError, isConfigured, shouldAlert };
