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
