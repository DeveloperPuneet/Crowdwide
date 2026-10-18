// Google / GitHub sign-in: the OAuth client (src/services/oauth.js) and the
// controller flow (src/controllers/oauthController.js). No database or network:
// models are stubbed in memory and global fetch is replaced per test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');

process.env.NODE_ENV = 'test';
delete process.env.ADMIN_EMAIL;

// ---- stub the side-effecting services BEFORE the controller is loaded --------
const mailer = require('../src/services/mailer');
const alerts = [];
mailer.sendSecurityAlert = async (user, details) => { alerts.push({ to: user.email, ...details }); };
mailer.sendNewDeviceAlert = async () => {};

const User = require('../src/models/User');
const LoginSession = require('../src/models/LoginSession');
const AccountEvent = require('../src/models/AccountEvent');
const SiteSetting = require('../src/models/SiteSetting');

let store = [];
const events = [];
User.findOne = async (query) => {
  if (query.socialLogins?.$elemMatch) {
    const { provider, providerId } = query.socialLogins.$elemMatch;
    return store.find((user) => user.socialLogins.some((entry) => entry.provider === provider && entry.providerId === providerId)) || null;
  }
  if (query.email) return store.find((user) => user.email === query.email) || null;
  return null;
};
User.exists = async (query) => (query.email ? store.some((user) => user.email === query.email) : query.username ? store.some((user) => user.username === query.username) : false);
User.prototype.save = async function save() {
  await this.validate();
  if (!store.includes(this)) store.push(this);
  return this;
};
LoginSession.exists = async () => null;
LoginSession.findOneAndUpdate = async () => null;
AccountEvent.create = async (entry) => { events.push(entry); return entry; };
SiteSetting.getSingleton = async () => ({ wavesWelcomeBonus: 0 });

const oauth = require('../src/services/oauth');
const controller = require('../src/controllers/oauthController');

// ---- helpers -----------------------------------------------------------------
const ENV_KEYS = ['GOOGLE_AUTH_CLIENT_ID', 'GOOGLE_AUTH_CLIENT_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'APP_URL', 'ADMIN_EMAIL'];
const originalFetch = globalThis.fetch;

function reset() {
  store = [];
  events.length = 0;
  alerts.length = 0;
  for (const key of ENV_KEYS) delete process.env[key];
  globalThis.fetch = originalFetch;
}
function configure() {
  process.env.APP_URL = 'https://app.example.com/';
  process.env.GOOGLE_AUTH_CLIENT_ID = 'g-id';
  process.env.GOOGLE_AUTH_CLIENT_SECRET = 'g-secret';
  process.env.GITHUB_CLIENT_ID = 'gh-id';
  process.env.GITHUB_CLIENT_SECRET = 'gh-secret';
}
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

// Fake provider: routes fetch() by URL.
function fakeProviders({ google = {}, github = {}, githubEmails = [], tokenError = false, networkDown = false } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (networkDown) throw new Error('ECONNREFUSED');
    const target = String(url);
    if (target === 'https://oauth2.googleapis.com/token') return json({ access_token: 'g-token' });
    if (target === 'https://github.com/login/oauth/access_token') return tokenError ? json({ error: 'bad_verification_code' }) : json({ access_token: 'gh-token' });
    if (target === 'https://openidconnect.googleapis.com/v1/userinfo') return json({ sub: 'g-123', email: 'Ada@Example.com', email_verified: true, name: 'Ada Lovelace', ...google });
    if (target === 'https://api.github.com/user') return json({ id: 4242, login: 'ada', name: 'Ada L', ...github });
    if (target === 'https://api.github.com/user/emails') return json(githubEmails);
    throw new Error(`unexpected fetch ${target}`);
  };
  return calls;
}

function makeReq({ params = {}, query = {}, body = {}, session = {} } = {}) {
  return { params, query, body, session, ip: '203.0.113.9', sessionID: 'sid-1', get: () => 'test-agent' };
}
function makeRes() {
  return { location: null, view: null, data: null, redirect(url) { this.location = url; }, render(view, data) { this.view = view; this.data = data; } };
}

// Runs start() and returns the state the provider will echo back.
function begin(provider, session = {}) {
  const req = makeReq({ params: { provider }, session });
  const res = makeRes();
  controller.start(req, res);
  return { req, res, state: req.session.oauthAttempt?.state, session: req.session };
}
async function finish(provider, session, { state, code = 'auth-code', extra = {} }) {
  const req = makeReq({ params: { provider }, query: { code, state, ...extra }, session });
  const res = makeRes();
  await controller.callback(req, res);
  return { req, res };
}
async function signIn(provider, session = {}) {
  const started = begin(provider, session);
  return finish(provider, started.session, { state: started.state });
}
const makeUser = (fields = {}) => new User({ name: 'Ada', email: 'ada@example.com', password: 'hash', isVerified: true, username: 'ada', ...fields });

// ---- oauth service -----------------------------------------------------------
test('a provider is offered only when both its id and secret are set', () => {
  reset();
  assert.deepEqual(oauth.enabledProviders(), []);
  process.env.GOOGLE_AUTH_CLIENT_ID = 'x';
  assert.deepEqual(oauth.enabledProviders(), []);
  process.env.GOOGLE_AUTH_CLIENT_SECRET = 'y';
  assert.deepEqual(oauth.enabledProviders(), [{ id: 'google', label: 'Google' }]);
  process.env.GITHUB_CLIENT_ID = 'x';
  process.env.GITHUB_CLIENT_SECRET = 'y';
  assert.deepEqual(oauth.enabledProviders().map((p) => p.id), ['google', 'github']);
  assert.equal(oauth.isEnabled('twitter'), false);
  reset();
});

test('authorize URLs carry client id, callback (built from APP_URL), state, scope and PKCE for Google only', () => {
  reset();
  configure();
  const google = new URL(oauth.buildAuthorizeUrl('google', { state: 'st', challenge: 'ch' }));
  assert.equal(google.origin + google.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(google.searchParams.get('client_id'), 'g-id');
  assert.equal(google.searchParams.get('redirect_uri'), 'https://app.example.com/auth/google/callback');
  assert.equal(google.searchParams.get('state'), 'st');
  assert.equal(google.searchParams.get('scope'), 'openid email profile');
  assert.equal(google.searchParams.get('code_challenge'), 'ch');
  assert.equal(google.searchParams.get('code_challenge_method'), 'S256');

  const github = new URL(oauth.buildAuthorizeUrl('github', { state: 'st', challenge: 'ch' }));
  assert.equal(github.origin + github.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(github.searchParams.get('redirect_uri'), 'https://app.example.com/auth/github/callback');
  assert.equal(github.searchParams.get('scope'), 'read:user user:email');
  assert.equal(github.searchParams.get('code_challenge'), null);
  reset();
});

test('statesMatch compares safely and rejects missing or different values', () => {
  assert.equal(oauth.statesMatch('abc', 'abc'), true);
  assert.equal(oauth.statesMatch('abc', 'abd'), false);
  assert.equal(oauth.statesMatch('abc', 'abcd'), false);
  assert.equal(oauth.statesMatch('', ''), false);
  assert.equal(oauth.statesMatch(undefined, 'abc'), false);
  assert.equal(oauth.statesMatch('abc', ['abc']), false);
});

test('Google profile: lower-cases the email and reports email_verified', async () => {
  reset(); configure();
  const calls = fakeProviders();
  const profile = await oauth.fetchProfile('google', 'code-1', { verifier: 'ver' });
  assert.deepEqual(profile, { provider: 'google', providerId: 'g-123', email: 'ada@example.com', emailVerified: true, name: 'Ada Lovelace' });
  const tokenCall = calls.find((c) => c.url.endsWith('/token'));
  assert.match(tokenCall.options.body, /code_verifier=ver/);
  assert.match(tokenCall.options.body, /redirect_uri=https%3A%2F%2Fapp\.example\.com%2Fauth%2Fgoogle%2Fcallback/);
  assert.equal(calls.find((c) => c.url.includes('userinfo')).options.headers.Authorization, 'Bearer g-token');
  reset();
});

test('Google profile: an unverified email is reported as unverified', async () => {
  reset(); configure();
  fakeProviders({ google: { email_verified: false } });
  assert.equal((await oauth.fetchProfile('google', 'c')).emailVerified, false);
  reset();
});

test('GitHub profile: uses the primary verified email, ignoring unverified ones', async () => {
  reset(); configure();
  fakeProviders({ githubEmails: [
    { email: 'evil@example.com', primary: true, verified: false },
    { email: 'second@example.com', primary: false, verified: true },
    { email: 'Main@Example.com', primary: false, verified: true }
  ] });
  let profile = await oauth.fetchProfile('github', 'c');
  assert.equal(profile.email, 'second@example.com');
  assert.equal(profile.emailVerified, true);

  fakeProviders({ githubEmails: [{ email: 'Main@Example.com', primary: true, verified: true }, { email: 'x@example.com', primary: false, verified: true }] });
  profile = await oauth.fetchProfile('github', 'c');
  assert.deepEqual(profile, { provider: 'github', providerId: '4242', email: 'main@example.com', emailVerified: true, name: 'Ada L' });
  reset();
});

test('GitHub profile: no verified email means emailVerified false; name falls back to login', async () => {
  reset(); configure();
  fakeProviders({ github: { name: null }, githubEmails: [{ email: 'a@example.com', primary: true, verified: false }] });
  const profile = await oauth.fetchProfile('github', 'c');
  assert.equal(profile.emailVerified, false);
  assert.equal(profile.email, '');
  assert.equal(profile.name, 'ada');
  reset();
});

test('provider failures become OAuthError with a safe message', async () => {
  reset(); configure();
  fakeProviders({ tokenError: true });
  await assert.rejects(() => oauth.fetchProfile('github', 'bad'), (error) => error instanceof oauth.OAuthError && !/bad_verification_code/.test(error.message));
  fakeProviders({ networkDown: true });
  await assert.rejects(() => oauth.fetchProfile('google', 'c'), oauth.OAuthError);
  delete process.env.GOOGLE_AUTH_CLIENT_ID;
  await assert.rejects(() => oauth.fetchProfile('google', 'c'), oauth.OAuthError);
  reset();
});

// ---- controller: start / callback validation ----------------------------------
test('start refuses a provider that is not configured and an unknown one', () => {
  reset();
  for (const provider of ['google', 'twitter']) {
    const { res, req } = begin(provider);
    assert.equal(res.location, '/auth/login');
    assert.equal(req.session.flash.type, 'error');
    assert.equal(req.session.oauthAttempt, undefined);
  }
});

test('start redirects to the provider and remembers state + a safe return path', () => {
  reset(); configure();
  const req = makeReq({ params: { provider: 'google' }, query: { next: '/communities/cool-club' } });
  const res = makeRes();
  controller.start(req, res);
  const url = new URL(res.location);
  assert.equal(url.hostname, 'accounts.google.com');
  assert.equal(url.searchParams.get('state'), req.session.oauthAttempt.state);
  assert.equal(req.session.returnTo, '/communities/cool-club');

  const evil = makeReq({ params: { provider: 'github' }, query: { next: 'https://evil.example/steal' } });
  controller.start(evil, makeRes());
  assert.equal(evil.session.returnTo, undefined);
  reset();
});

test('callback rejects a wrong state, a replayed attempt, an expired attempt and a cancelled sign-in without calling the provider', async () => {
  reset(); configure();
  let fetched = 0;
  globalThis.fetch = async () => { fetched += 1; throw new Error('must not fetch'); };

  let started = begin('google');
  let result = await finish('google', started.session, { state: 'forged' });
  assert.equal(result.res.location, '/auth/login');
  assert.match(result.req.session.flash.message, /expired or was not valid/);

  // the attempt was consumed, so replaying the right state now fails too
  result = await finish('google', started.session, { state: started.state });
  assert.match(result.req.session.flash.message, /expired or was not valid/);

  started = begin('google');
  started.session.oauthAttempt.startedAt = Date.now() - 11 * 60 * 1000;
  result = await finish('google', started.session, { state: started.state });
  assert.match(result.req.session.flash.message, /expired or was not valid/);

  started = begin('github');
  result = await finish('google', started.session, { state: started.state }); // wrong provider
  assert.match(result.req.session.flash.message, /expired or was not valid/);

  started = begin('github');
  result = await finish('github', started.session, { state: started.state, code: undefined, extra: { error: 'access_denied' } });
  assert.match(result.req.session.flash.message, /cancelled/);
  assert.equal(fetched, 0);
  reset();
});

test('callback refuses an email the provider has not verified', async () => {
  reset(); configure();
  fakeProviders({ google: { email_verified: false } });
  const { req, res } = await signIn('google');
  assert.equal(res.location, '/auth/login');
  assert.match(req.session.flash.message, /verified email/);
  assert.equal(store.length, 0);
  assert.equal(req.session.user, undefined);
  reset();
});

// ---- controller: creating accounts ---------------------------------------------
test('a brand-new person is sent to the confirm page and nothing is created yet', async () => {
  reset(); configure();
  fakeProviders();
  const { req, res } = await signIn('google');
  assert.equal(res.location, '/auth/social/confirm');
  assert.equal(store.length, 0);
  assert.equal(req.session.user, undefined);
  assert.equal(req.session.pendingSocialSignup.profile.email, 'ada@example.com');

  const page = makeRes();
  controller.confirmPage(makeReq({ session: req.session }), page);
  assert.equal(page.view, 'pages/social-confirm');
  assert.equal(page.data.providerLabel, 'Google');
  reset();
});

test('confirming requires the Terms, then creates a verified, password-less account and signs in', async () => {
  reset(); configure();
  fakeProviders();
  const { req } = await signIn('google');
  const session = req.session;

  const refused = makeRes();
  await controller.confirm(makeReq({ session, body: { name: 'Ada' } }), refused);
  assert.equal(refused.location, '/auth/social/confirm');
  assert.equal(store.length, 0);

  const ok = makeRes();
  const confirmReq = makeReq({ session, body: { name: '  Ada the Great  ', acceptTerms: 'on' } });
  await controller.confirm(confirmReq, ok);
  assert.equal(ok.location, '/welcome');
  assert.equal(store.length, 1);
  const user = store[0];
  assert.equal(user.name, 'Ada the Great');
  assert.equal(user.email, 'ada@example.com');
  assert.equal(user.isVerified, true);
  assert.equal(user.passwordSet, false);
  assert.equal(user.role, 'user');
  assert.match(user.username, /^[a-z0-9_]{3,24}$/);
  assert.notEqual(user.password, '');
  assert.equal(user.socialLogins[0].provider, 'google');
  assert.equal(user.socialLogins[0].providerId, 'g-123');
  assert.equal(session.user.email, 'ada@example.com');
  assert.equal(session.pendingSocialSignup, undefined);
  reset();
});

test('confirm without a pending sign-up (or after it expired) sends the person back to register', async () => {
  reset(); configure();
  let res = makeRes();
  await controller.confirm(makeReq({ body: { name: 'x', acceptTerms: 'on' } }), res);
  assert.equal(res.location, '/auth/register');

  const expired = { pendingSocialSignup: { profile: { provider: 'google', providerId: '1', email: 'a@b.co', name: 'A' }, expiresAt: Date.now() - 1 } };
  res = makeRes();
  await controller.confirm(makeReq({ session: expired, body: { name: 'x', acceptTerms: 'on' } }), res);
  assert.equal(res.location, '/auth/register');
  assert.equal(store.length, 0);
  reset();
});

test('confirm does not create a duplicate if the email got registered in the meantime', async () => {
  reset(); configure();
  fakeProviders();
  const { req } = await signIn('google');
  store.push(makeUser());
  const res = makeRes();
  await controller.confirm(makeReq({ session: req.session, body: { name: 'Ada', acceptTerms: 'on' } }), res);
  assert.equal(res.location, '/auth/login');
  assert.equal(store.length, 1);
  reset();
});

test('ADMIN_EMAIL becomes admin on social sign-up too', async () => {
  reset(); configure();
  process.env.ADMIN_EMAIL = 'ADA@example.com';
  fakeProviders();
  const { req } = await signIn('google');
  await controller.confirm(makeReq({ session: req.session, body: { name: 'Ada', acceptTerms: 'on' } }), makeRes());
  assert.equal(store[0].role, 'admin');
  reset();
});

// ---- controller: existing accounts ---------------------------------------------
test('a verified account with the same email is linked and signed in, with an alert and a history entry', async () => {
  reset(); configure();
  fakeProviders();
  const existing = makeUser();
  store.push(existing);
  const { req, res } = await signIn('google');
  assert.equal(res.location, '/dashboard');
  assert.equal(store.length, 1);
  assert.equal(existing.socialLogins.length, 1);
  assert.equal(existing.socialLogins[0].providerId, 'g-123');
  assert.equal(existing.passwordSet, true);
  assert.equal(req.session.user.id, existing.id);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].subject, /Google sign-in connected/);
  assert.ok(events.some((entry) => entry.type === 'social-login-linked'));
  reset();
});

test('signing in again with a linked identity needs no email match and sends no alert', async () => {
  reset(); configure();
  fakeProviders({ google: { email: 'changed@example.com' } });
  const existing = makeUser({ socialLogins: [{ provider: 'google', providerId: 'g-123', email: 'ada@example.com' }] });
  store.push(existing);
  const { req, res } = await signIn('google');
  assert.equal(res.location, '/dashboard');
  assert.equal(existing.socialLogins.length, 1);
  assert.equal(req.session.user.id, existing.id);
  assert.equal(alerts.length, 0);
  reset();
});

test('after sign-in the visitor returns to the invite / page they came from', async () => {
  reset(); configure();
  fakeProviders();
  store.push(makeUser());
  const req = makeReq({ params: { provider: 'google' }, query: { next: '/groups/join/abc123' } });
  controller.start(req, makeRes());
  const { res } = await finish('google', req.session, { state: req.session.oauthAttempt.state });
  assert.equal(res.location, '/groups/join/abc123');
  reset();
});

test('an unverified password sign-up is verified by the provider and its password is discarded', async () => {
  reset(); configure();
  fakeProviders();
  const squatter = makeUser({ isVerified: false, password: 'attacker-chosen-hash', verificationCode: '123456', resetToken: 'tok' });
  store.push(squatter);
  const { req, res } = await signIn('google');
  assert.equal(res.location, '/welcome');
  assert.equal(squatter.isVerified, true);
  assert.notEqual(squatter.password, 'attacker-chosen-hash');
  assert.equal(squatter.passwordSet, false);
  assert.equal(squatter.verificationCode, undefined);
  assert.equal(squatter.resetToken, undefined);
  assert.equal(req.session.user.id, squatter.id);
  reset();
});

test('a second, different account from the same provider is not silently attached to the email', async () => {
  reset(); configure();
  fakeProviders({ google: { sub: 'someone-else' } });
  const existing = makeUser({ socialLogins: [{ provider: 'google', providerId: 'g-123', email: 'ada@example.com' }] });
  store.push(existing);
  const { req, res } = await signIn('google');
  assert.equal(res.location, '/auth/login');
  assert.match(req.session.flash.message, /different Google account/);
  assert.equal(existing.socialLogins.length, 1);
  assert.equal(req.session.user, undefined);
  reset();
});

test('suspended accounts cannot sign in (or be linked) through a provider', async () => {
  reset(); configure();
  fakeProviders();
  const suspended = makeUser({ suspendedUntil: new Date(Date.now() + 86400000), suspensionReason: 'spam' });
  store.push(suspended);
  const { req, res } = await signIn('google');
  assert.equal(res.location, '/auth/login');
  assert.match(req.session.flash.message, /suspended/);
  assert.match(req.session.flash.message, /spam/);
  assert.equal(suspended.socialLogins.length, 0);
  assert.equal(req.session.user, undefined);

  // already linked + suspended
  suspended.socialLogins.push({ provider: 'google', providerId: 'g-123', email: 'ada@example.com' });
  const again = await signIn('google');
  assert.equal(again.res.location, '/auth/login');
  assert.equal(again.req.session.user, undefined);
  reset();
});

test('accounts with two-factor still have to pass the authenticator step', async () => {
  reset(); configure();
  fakeProviders();
  const secured = makeUser({ twoFactorEnabled: true, twoFactorSecret: 'SECRET' });
  store.push(secured);
  const { req, res } = await signIn('google');
  assert.equal(res.location, '/auth/2fa');
  assert.equal(req.session.pendingTwoFactorUser, secured.id);
  assert.equal(req.session.user, undefined);
  reset();
});

test('an unexpected failure shows the generic message and never leaks details', async () => {
  reset(); configure();
  fakeProviders();
  const original = User.findOne;
  User.findOne = async () => { throw new Error('mongo exploded: secret-connection-string'); };
  const { req, res } = await signIn('google');
  User.findOne = original;
  assert.equal(res.location, '/auth/login');
  assert.equal(req.session.flash.message, 'Sign in is temporarily unavailable.');
  reset();
});

// ---- model, routes and views ---------------------------------------------------
test('existing accounts default to having a password; social-only accounts are flagged', () => {
  const legacy = new User({ name: 'Old', email: 'old@example.com', password: 'h' });
  assert.equal(legacy.passwordSet, true);
  assert.deepEqual(legacy.socialLogins.toObject(), []);
  assert.ok(new User({ name: 'x', email: 'x@y.co', password: 'h', socialLogins: [{ provider: 'myspace', providerId: '1' }] }).validateSync());
});

test('auth routes expose only google and github', () => {
  const router = require('../src/routes/auth');
  const paths = router.stack.filter((layer) => layer.route).map((layer) => `${Object.keys(layer.route.methods)[0]} ${layer.route.path}`);
  assert.ok(paths.includes('get /social/confirm'));
  assert.ok(paths.includes('post /social/confirm'));
  assert.ok(paths.some((p) => p.startsWith('get /:provider(google|github)') && !p.includes('callback')));
  assert.ok(paths.some((p) => p.includes('callback')));
});

const views = path.join(__dirname, '..', 'src', 'views');
const { icon } = require('../src/utils/icons');
const base = { icon, csrfToken: 'tok', flash: null, currentUser: null, appUrl: 'http://x', cspNonce: 'n' };
const render = (file, data = {}) => ejs.renderFile(path.join(views, file), { ...base, ...data });

test('sign-in and sign-up pages show provider buttons only when configured, and keep the return path', async () => {
  const plainLogin = await render('pages/login.ejs', { title: 'Sign in' });
  assert.ok(!plainLogin.includes('social-auth'));
  const plainRegister = await render('pages/register.ejs', { title: 'Create your account', captcha: { a: 1, b: 2 }, turnstileSiteKey: '' });
  assert.ok(!plainRegister.includes('social-auth'));

  const providers = [{ id: 'google', label: 'Google' }, { id: 'github', label: 'GitHub' }];
  const login = await render('pages/login.ejs', { title: 'Sign in', socialProviders: providers, socialNext: '/communities/club' });
  assert.match(login, /href="\/auth\/google\?next=%2Fcommunities%2Fclub"/);
  assert.match(login, /href="\/auth\/github\?next=%2Fcommunities%2Fclub"/);
  const register = await render('pages/register.ejs', { title: 'Create your account', captcha: { a: 1, b: 2 }, turnstileSiteKey: '', socialProviders: providers });
  assert.match(register, /href="\/auth\/google"/);
  assert.match(register, /Continue with|or continue with/);
});

test('the confirm page renders the details, a required Terms box and escapes the provider name', async () => {
  const html = await render('pages/social-confirm.ejs', { title: 'Finish signing up', providerLabel: 'GitHub', profile: { provider: 'github', providerId: '1', email: 'a@b.co', name: '"><script>alert(1)</script>' } });
  assert.match(html, /name="acceptTerms"[^>]*required/);
  assert.match(html, /action="\/auth\/social\/confirm"/);
  assert.match(html, /name="_csrf" value="tok"/);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /a@b\.co/);
});

test('settings > security explains a missing password for social-only accounts and lists connected sign-in', async () => {
  const sections = { section: 'security', sessions: [], ownedCommunities: [], blockedUsers: [], appeals: [], accountEvents: [], sessionID: 's', pushConfigured: false, pushPublicKey: '' };
  const socialOnly = await render('pages/settings.ejs', { ...sections, title: 'Settings', currentUser: { id: 'u', name: 'A', role: 'user' }, user: { _id: 'u', name: 'A', email: 'a@b.co', passwordSet: false, socialLogins: [{ provider: 'github', providerId: '1' }], notificationPreferences: {} } });
  assert.ok(!socialOnly.includes('name="currentPassword"'));
  assert.match(socialOnly, /Forgot password/);
  assert.match(socialOnly, /sign in with GitHub/);

  const normal = await render('pages/settings.ejs', { ...sections, title: 'Settings', currentUser: { id: 'u', name: 'A', role: 'user' }, user: { _id: 'u', name: 'A', email: 'a@b.co', notificationPreferences: {} } });
  assert.match(normal, /name="currentPassword"/);
  assert.ok(!normal.includes('Connected sign-in'));
});

test('the env example and deployment guide document every new variable', () => {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  const guide = fs.readFileSync(path.join(__dirname, '..', 'DEPLOYMENT.md'), 'utf8');
  for (const name of ['GOOGLE_AUTH_CLIENT_ID', 'GOOGLE_AUTH_CLIENT_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET']) {
    assert.ok(env.includes(`${name}=`), `${name} missing from .env.example`);
    assert.ok(guide.includes(name), `${name} missing from DEPLOYMENT.md`);
  }
});
