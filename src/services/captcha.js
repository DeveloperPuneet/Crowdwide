// Registration bot protection, in layers:
//
//  1. Managed CAPTCHA (Cloudflare Turnstile) - used automatically when both
//     TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are set.
//  2. Built-in arithmetic challenge - the dependency-free default when no
//     managed keys are configured. Single-use and time-limited.
//  3. Honeypot field + minimum-fill-time check - invisible to people, catches
//     scripts that fill every field and submit instantly. Applies in both modes.
const crypto = require('crypto');

const CHALLENGE_TTL_MS = 10 * 60 * 1000;
// Instant-submit check; disabled under NODE_ENV=test so automated signup
// tests (which submit immediately) keep working. Override with CAPTCHA_MIN_FILL_MS.
const MIN_FILL_MS = process.env.NODE_ENV === 'test' ? 0 : Number(process.env.CAPTCHA_MIN_FILL_MS ?? 2000);
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

function turnstileEnabled() {
  return Boolean(process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY);
}

function turnstileSiteKey() {
  return process.env.TURNSTILE_SITE_KEY || '';
}

function generateChallenge(req) {
  const a = crypto.randomInt(1, 10);
  const b = crypto.randomInt(1, 10);
  req.session.captcha = { answer: a + b, createdAt: Date.now() };
  return { a, b };
}

// Single-use and time-limited: verifying (whether it passes or fails)
// always clears the stored answer, and a challenge older than 10 minutes
// is rejected even with the right answer.
function verifyChallenge(req, submittedAnswer) {
  const challenge = req.session.captcha;
  delete req.session.captcha;
  if (!challenge) return false;
  if (Date.now() - challenge.createdAt > CHALLENGE_TTL_MS) return false;
  const submitted = Number(String(submittedAnswer ?? '').trim());
  return Number.isFinite(submitted) && submitted === challenge.answer;
}

// Call BEFORE verifyChallenge (which clears the stored challenge). `startedAt`
// is when the form was rendered; a filled honeypot or an instant submit means
// a script, not a person.
function looksAutomated(req, now = Date.now()) {
  if (String(req.body?.website ?? '').trim() !== '') return true;
  const startedAt = req.session?.captcha?.createdAt ?? req.session?.registerFormShownAt;
  if (startedAt && now - startedAt < MIN_FILL_MS) return true;
  return false;
}

async function verifyTurnstile(token, remoteIp, fetchImpl = fetch) {
  if (!turnstileEnabled() || !token) return false;
  try {
    const body = new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY, response: String(token) });
    if (remoteIp) body.set('remoteip', remoteIp);
    const response = await fetchImpl(TURNSTILE_VERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(8000) });
    if (!response.ok) return false;
    const result = await response.json();
    return result.success === true;
  } catch (error) {
    return false;
  }
}

module.exports = { generateChallenge, verifyChallenge, looksAutomated, verifyTurnstile, turnstileEnabled, turnstileSiteKey, MIN_FILL_MS };
