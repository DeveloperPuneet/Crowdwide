// A dependency-free arithmetic challenge, not a production-grade CAPTCHA
// (no external service key is available in this environment to wire up
// reCAPTCHA/hCaptcha/Turnstile). This stops simple scripted signups; it
// will not stop a determined attacker or a vision-capable bot. Swap in a
// managed CAPTCHA service if bot signups become a real problem - see
// Known Gaps in todo.txt.
const crypto = require('crypto');

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
  if (Date.now() - challenge.createdAt > 10 * 60 * 1000) return false;
  const submitted = Number(String(submittedAnswer ?? '').trim());
  return Number.isFinite(submitted) && submitted === challenge.answer;
}

module.exports = { generateChallenge, verifyChallenge };
