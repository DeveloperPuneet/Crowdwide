// Behaviour of the hardened sign-in, verification and reset flows, with the database stubbed out.
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false); // anything not stubbed fails fast instead of waiting for a database

const mailer = require('../src/services/mailer');
const sent = { reset: [], code: [], alert: [] };
mailer.sendPasswordResetLink = (user, url) => { sent.reset.push(url); };
mailer.sendVerificationCode = (user, code) => { sent.code.push(code); };
mailer.sendSecurityAlert = (user, details) => { sent.alert.push(details.subject); };

const User = require('../src/models/User');
const LoginSession = require('../src/models/LoginSession');
const { sha256 } = require('../src/services/unverified');
const auth = require('../src/controllers/authController');

LoginSession.exists = async () => null;
LoginSession.findOneAndUpdate = async () => ({});
LoginSession.deleteOne = async () => ({});
LoginSession.deleteMany = async () => ({});
LoginSession.find = () => ({ select: () => ({ lean: async () => [] }) });

function makeUser(extra = {}) {
  const doc = { id: 'u1', _id: 'u1', name: 'Ravi Kumar', email: 'ravi@example.com', isVerified: true, role: 'user', loginAttempts: 0, notificationPreferences: {}, saved: 0, ...extra };
  doc.save = async function save() { this.saved += 1; };
  doc.isModified = () => false;
  return doc;
}
function call(handler, { body = {}, session = {}, params = {}, query = {} } = {}) {
  const flashes = [];
  const req = {
    body, params, query, ip: '1.2.3.4', sessionID: 'old-sid', sessionStore: { destroy: (id, cb) => cb() },
    get: () => 'test-agent',
    session: { ...session, regenerate(cb) { const keep = this.returnTo; for (const key of Object.keys(this)) if (typeof this[key] !== 'function') delete this[key]; this.regenerated = true; if (keep) this.kept = keep; cb(); } }
  };
  return new Promise((resolve, reject) => {
    const res = { redirect: (to) => resolve({ to, req }), render: (view, data) => resolve({ view, data, req }) };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}
const flash = (req) => req.session.flash?.message;

test('wrong verification codes are counted and the code dies after five', async () => {
  const user = makeUser({ isVerified: false, verificationCode: '123456', verificationExpires: Date.now() + 60000, verificationAttempts: 0 });
  User.findOne = async () => user;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const result = await call(auth.verify, { body: { email: 'ravi@example.com', code: '000000' } });
    assert.match(flash(result.req), /not correct/);
    assert.equal(user.verificationAttempts, attempt);
    assert.equal(user.verificationCode, '123456');
  }
  const fifth = await call(auth.verify, { body: { email: 'ravi@example.com', code: '000000' } });
  assert.match(flash(fifth.req), /Too many wrong codes/);
  assert.equal(user.verificationCode, undefined);
  // Even the right code no longer works - a new one has to be requested.
  const late = await call(auth.verify, { body: { email: 'ravi@example.com', code: '123456' } });
  assert.match(flash(late.req), /invalid or has expired/);
  assert.equal(user.isVerified, false);
});

test('the right code verifies, signs in with a fresh session id and clears the link and counters', async () => {
  const user = makeUser({ isVerified: false, verificationCode: '654321', verificationExpires: Date.now() + 60000, verificationAttempts: 2, verificationLinkHash: 'x', verificationLinkExpires: new Date(Date.now() + 1e6) });
  User.findOne = async () => user;
  const result = await call(auth.verify, { body: { email: 'RAVI@example.com ', code: '654321' }, session: { returnTo: '/communities/books' } });
  assert.equal(result.to, '/welcome');
  assert.equal(user.isVerified, true);
  assert.equal(user.verificationAttempts, 0);
  assert.equal(user.verificationLinkHash, undefined);
  assert.equal(result.req.session.regenerated, true, 'session id is regenerated');
  assert.equal(result.req.session.user.id, 'u1');
  assert.equal(result.req.session.kept, '/communities/books', 'the return link survives the new session');
});

test('operator objects in the email or code fields are treated as empty text', async () => {
  User.findOne = async () => { throw new Error('must not query with an object'); };
  const result = await call(auth.verify, { body: { email: { $ne: '' }, code: { $ne: '' } } });
  assert.match(flash(result.req), /invalid or has expired/);
});

test('password reset stores only a hash, accepts the emailed token once, and enforces the password policy', async () => {
  const user = makeUser({ email: 'ravi@example.com' });
  User.findOne = async (filter) => (filter.email === 'ravi@example.com' ? user : null);
  await call(auth.forgot, { body: { email: 'Ravi@Example.com' } });
  assert.equal(sent.reset.length, 1);
  const raw = new URL(sent.reset[0]).searchParams.get('token');
  assert.match(raw, /^[a-f0-9]{48}$/);
  assert.equal(user.resetToken, sha256(raw));
  assert.notEqual(user.resetToken, raw);

  User.findOne = async (filter) => (filter.resetToken === sha256(raw) && filter.resetExpires.$gt ? user : null);
  const weak = await call(auth.reset, { body: { token: raw, password: 'password123' } });
  assert.match(flash(weak.req), /too easy/);
  assert.ok(user.resetToken, 'a weak password does not burn the token');

  const bad = await call(auth.reset, { body: { token: { $gt: '' }, password: 'a-strong-passphrase-1' } });
  assert.match(flash(bad.req), /invalid or has expired/);

  const ok = await call(auth.reset, { body: { token: raw, password: 'a-strong-passphrase-1' } });
  assert.equal(ok.to, '/auth/login');
  assert.equal(user.resetToken, undefined);
  assert.ok(await bcrypt.compare('a-strong-passphrase-1', user.password));
  assert.ok(sent.alert.includes('Your Crowdwide password was reset'));
});

test('sign-in tells nobody about a suspension until the password is right, and five failures alert the owner', async () => {
  const user = makeUser({ password: await bcrypt.hash('right-password-1', 4), suspendedUntil: new Date(Date.now() + 86400000), suspensionReason: 'spam' });
  User.findOne = async () => user;
  const wrong = await call(auth.login, { body: { email: user.email, password: 'wrong-password' } });
  assert.match(flash(wrong.req), /not recognized/);
  assert.doesNotMatch(flash(wrong.req), /suspended/);
  const right = await call(auth.login, { body: { email: user.email, password: 'right-password-1' } });
  assert.match(flash(right.req), /suspended until/);

  const victim = makeUser({ password: await bcrypt.hash('right-password-1', 4) });
  User.findOne = async () => victim;
  for (let i = 0; i < 5; i += 1) await call(auth.login, { body: { email: victim.email, password: 'nope-nope-nope' } });
  assert.ok(victim.loginLockedUntil > Date.now());
  assert.ok(sent.alert.includes('Sign-in attempts were blocked on your Crowdwide account'));
  const locked = await call(auth.login, { body: { email: victim.email, password: 'right-password-1' } });
  assert.match(flash(locked.req), /Too many failed attempts/);
});

test('an unknown email still gets the same message as a wrong password', async () => {
  User.findOne = async () => null;
  const result = await call(auth.login, { body: { email: 'nobody@example.com', password: 'whatever-it-is' } });
  assert.match(flash(result.req), /not recognized/);
});
