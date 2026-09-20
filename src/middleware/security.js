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

// Chats poll for new messages every few seconds; this keeps a runaway tab (or a
// script) from hammering a small free-tier server.
const pollLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 150,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { messages: [], error: 'Slow down a little.' }
});

const gifLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 40,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { results: [], next: null, error: 'GIF search is busy right now. Try again in a moment.' }
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many API requests. Try again shortly.' }
});

function csrfProtection(req, res, next) {
  if (req.is('multipart/form-data')) return next();
  return csrfSynchronisedProtection(req, res, next);
}

module.exports = { csrfSynchronisedProtection, csrfProtection, generateToken, authLimiter, interactionLimiter, apiLimiter, pollLimiter, gifLimiter };
