// One place that decides the secret used to sign sessions and unsubscribe links.
// In production a missing SESSION_SECRET used to fall back to a value that is
// public in the source code, which lets anyone forge cookies. Now production
// without one gets a random per-process secret (sessions then do not survive a
// restart - annoying, but safe) and a loud warning.
const crypto = require('crypto');
const logger = require('../services/logger');

const DEV_SECRET = 'crowdwide-development-secret';
let generated = null;

function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.NODE_ENV !== 'production') return DEV_SECRET;
  if (!generated) {
    generated = crypto.randomBytes(48).toString('hex');
    logger.error('SESSION_SECRET is not set in production. Using a random secret for this process: members will be signed out on every restart. Set SESSION_SECRET to a long random value.');
  }
  return generated;
}

module.exports = { sessionSecret };
