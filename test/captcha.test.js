const test = require('node:test');
const assert = require('node:assert/strict');
const { generateChallenge, verifyChallenge } = require('../src/services/captcha');

function fakeReq() {
  return { session: {} };
}

test('generateChallenge stores the correct answer in the session and returns the two numbers', () => {
  const req = fakeReq();
  const { a, b } = generateChallenge(req);
  assert.equal(req.session.captcha.answer, a + b);
});

test('verifyChallenge accepts the correct sum', () => {
  const req = fakeReq();
  const { a, b } = generateChallenge(req);
  assert.equal(verifyChallenge(req, String(a + b)), true);
});

test('verifyChallenge accepts the correct sum with surrounding whitespace', () => {
  const req = fakeReq();
  const { a, b } = generateChallenge(req);
  assert.equal(verifyChallenge(req, `  ${a + b}  `), true);
});

test('verifyChallenge rejects a wrong answer', () => {
  const req = fakeReq();
  const { a, b } = generateChallenge(req);
  assert.equal(verifyChallenge(req, String(a + b + 1)), false);
});

test('verifyChallenge rejects a non-numeric answer', () => {
  const req = fakeReq();
  generateChallenge(req);
  assert.equal(verifyChallenge(req, 'banana'), false);
});

test('verifyChallenge rejects when no challenge was ever generated', () => {
  const req = fakeReq();
  assert.equal(verifyChallenge(req, '5'), false);
});

test('verifyChallenge is single-use: a second attempt with the same session fails even with the right answer', () => {
  const req = fakeReq();
  const { a, b } = generateChallenge(req);
  assert.equal(verifyChallenge(req, String(a + b)), true);
  assert.equal(verifyChallenge(req, String(a + b)), false);
});

test('verifyChallenge rejects a challenge older than 10 minutes', () => {
  const req = fakeReq();
  const { a, b } = generateChallenge(req);
  req.session.captcha.createdAt = Date.now() - 11 * 60 * 1000;
  assert.equal(verifyChallenge(req, String(a + b)), false);
});

const captchaModule = require('../src/services/captcha');

test('looksAutomated flags a filled honeypot field', () => {
  const req = { session: {}, body: { website: 'http://spam.example' } };
  assert.equal(captchaModule.looksAutomated(req), true);
});

test('looksAutomated ignores an empty honeypot and a form that was open long enough', () => {
  const req = { session: { captcha: { createdAt: Date.now() - 60000 } }, body: { website: '' } };
  assert.equal(captchaModule.looksAutomated(req), false);
});

test('looksAutomated flags an instant submit when the minimum fill time is enforced', () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  delete require.cache[require.resolve('../src/services/captcha')];
  const fresh = require('../src/services/captcha');
  const req = { session: { captcha: { createdAt: 1000 } }, body: {} };
  assert.equal(fresh.looksAutomated(req, 1500), true);
  assert.equal(fresh.looksAutomated(req, 4000), false);
  process.env.NODE_ENV = previous;
  delete require.cache[require.resolve('../src/services/captcha')];
});

test('verifyTurnstile is off without keys, and validates against the siteverify response when configured', async () => {
  delete process.env.TURNSTILE_SITE_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;
  assert.equal(captchaModule.turnstileEnabled(), false);
  assert.equal(await captchaModule.verifyTurnstile('token', '1.1.1.1', async () => ({ ok: true, json: async () => ({ success: true }) })), false);

  process.env.TURNSTILE_SITE_KEY = 'site';
  process.env.TURNSTILE_SECRET_KEY = 'secret';
  assert.equal(captchaModule.turnstileEnabled(), true);
  let sent;
  const ok = await captchaModule.verifyTurnstile('good-token', '1.1.1.1', async (url, options) => { sent = { url, body: options.body.toString() }; return { ok: true, json: async () => ({ success: true }) }; });
  assert.equal(ok, true);
  assert.match(sent.url, /turnstile\/v0\/siteverify/);
  assert.match(sent.body, /secret=secret/);
  assert.match(sent.body, /response=good-token/);
  assert.equal(await captchaModule.verifyTurnstile('bad', '', async () => ({ ok: true, json: async () => ({ success: false }) })), false);
  assert.equal(await captchaModule.verifyTurnstile('', '', async () => { throw new Error('should not be called'); }), false);
  assert.equal(await captchaModule.verifyTurnstile('x', '', async () => { throw new Error('network'); }), false);
  delete process.env.TURNSTILE_SITE_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;
});
