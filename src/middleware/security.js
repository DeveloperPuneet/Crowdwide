const rateLimit = require('express-rate-limit');
const { csrfSync } = require('csrf-sync');

const { csrfSynchronisedProtection, generateToken } = csrfSync({
  getTokenFromRequest: (req) => req.headers['x-csrf-token'] || req.body?._csrf
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: 'Too many authentication attempts. Try again in a few minutes.'
});

const interactionLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: 'You are moving too quickly. Try again shortly.'
});

function csrfProtection(req, res, next) {
  if (req.is('multipart/form-data')) return next();
  return csrfSynchronisedProtection(req, res, next);
}

module.exports = { csrfSynchronisedProtection, csrfProtection, generateToken, authLimiter, interactionLimiter };
