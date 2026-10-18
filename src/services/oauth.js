// "Continue with Google / GitHub": a small OAuth 2.0 authorization-code client.
//
// No SDK is needed - each provider is just an authorize URL, a token endpoint
// and a "who is this" endpoint. A provider is only offered on the sign-in /
// sign-up pages when BOTH of its env vars are set, so a deployment without
// them behaves exactly as before.
//
//   Google : GOOGLE_AUTH_CLIENT_ID, GOOGLE_AUTH_CLIENT_SECRET
//   GitHub : GITHUB_CLIENT_ID,      GITHUB_CLIENT_SECRET
//
// Callback URLs to register with each provider (APP_URL is your public site):
//   {APP_URL}/auth/google/callback
//   {APP_URL}/auth/github/callback
const crypto = require('crypto');

const PROVIDERS = {
  google: {
    label: 'Google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
    pkce: true,
    clientId: () => process.env.GOOGLE_AUTH_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_AUTH_CLIENT_SECRET
  },
  github: {
    label: 'GitHub',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userUrl: 'https://api.github.com/user',
    emailsUrl: 'https://api.github.com/user/emails',
    scope: 'read:user user:email',
    pkce: false,
    clientId: () => process.env.GITHUB_CLIENT_ID,
    clientSecret: () => process.env.GITHUB_CLIENT_SECRET
  }
};

const REQUEST_TIMEOUT_MS = 10000;

// An error whose message is safe to show to the person signing in.
class OAuthError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'OAuthError';
    this.cause = cause;
  }
}

const providerIds = () => Object.keys(PROVIDERS);
const isKnownProvider = (id) => Object.prototype.hasOwnProperty.call(PROVIDERS, id);
const isEnabled = (id) => isKnownProvider(id) && Boolean(PROVIDERS[id].clientId() && PROVIDERS[id].clientSecret());
const providerLabel = (id) => (isKnownProvider(id) ? PROVIDERS[id].label : id);
const enabledProviders = () => providerIds().filter(isEnabled).map((id) => ({ id, label: PROVIDERS[id].label }));

const appUrl = () => String(process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
const redirectUri = (id) => `${appUrl()}/auth/${id}/callback`;

const base64Url = (buffer) => buffer.toString('base64url');

// Per-attempt secrets kept in the visitor's session: `state` ties the callback
// to the browser that started it (CSRF), the PKCE verifier stops a stolen code
// from being redeemed elsewhere.
function newAttempt() {
  const verifier = base64Url(crypto.randomBytes(32));
  return {
    state: base64Url(crypto.randomBytes(24)),
    verifier,
    challenge: base64Url(crypto.createHash('sha256').update(verifier).digest())
  };
}

function statesMatch(expected, received) {
  if (typeof expected !== 'string' || typeof received !== 'string' || !expected || expected.length !== received.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

function buildAuthorizeUrl(id, { state, challenge }) {
  const provider = PROVIDERS[id];
  const url = new URL(provider.authorizeUrl);
  url.searchParams.set('client_id', provider.clientId());
  url.searchParams.set('redirect_uri', redirectUri(id));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', provider.scope);
  url.searchParams.set('state', state);
  if (provider.pkce) {
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  if (id === 'google') url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

async function requestJson(fetchImpl, url, options, what) {
  let response;
  try {
    response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw new OAuthError(`We could not reach the sign-in provider (${what}). Please try again.`, error);
  }
  let body = null;
  try { body = await response.json(); } catch (error) { /* non-JSON body handled below */ }
  if (!response.ok || !body) throw new OAuthError(`The sign-in provider rejected the request (${what}). Please try again.`, new Error(`${what}: HTTP ${response.status}`));
  return body;
}

async function exchangeCode(id, code, { verifier, fetchImpl }) {
  const provider = PROVIDERS[id];
  const form = new URLSearchParams({
    client_id: provider.clientId(),
    client_secret: provider.clientSecret(),
    code,
    redirect_uri: redirectUri(id),
    grant_type: 'authorization_code'
  });
  if (provider.pkce && verifier) form.set('code_verifier', verifier);
  const body = await requestJson(fetchImpl, provider.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString()
  }, 'token');
  // GitHub answers HTTP 200 with { error } for a bad or reused code.
  if (body.error || !body.access_token) throw new OAuthError('The sign-in provider did not accept that sign-in. Please try again.', new Error(String(body.error || 'no access_token')));
  return body.access_token;
}

const authHeaders = (accessToken) => ({ Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': 'Crowdwide' });

async function googleProfile(accessToken, fetchImpl) {
  const info = await requestJson(fetchImpl, PROVIDERS.google.userUrl, { headers: authHeaders(accessToken) }, 'profile');
  const email = String(info.email || '').toLowerCase().trim();
  return {
    provider: 'google',
    providerId: info.sub ? String(info.sub) : '',
    email,
    // Google returns a boolean, but some older responses used the string "true".
    emailVerified: info.email_verified === true || info.email_verified === 'true',
    name: String(info.name || info.given_name || email.split('@')[0] || '').trim()
  };
}

async function githubProfile(accessToken, fetchImpl) {
  const headers = { ...authHeaders(accessToken), Accept: 'application/vnd.github+json' };
  const info = await requestJson(fetchImpl, PROVIDERS.github.userUrl, { headers }, 'profile');
  const emails = await requestJson(fetchImpl, PROVIDERS.github.emailsUrl, { headers }, 'emails');
  // Only an address GitHub itself has verified may ever identify an account here.
  const verified = Array.isArray(emails) ? emails.filter((entry) => entry && entry.verified && entry.email) : [];
  const chosen = verified.find((entry) => entry.primary) || verified[0] || null;
  return {
    provider: 'github',
    providerId: info.id ? String(info.id) : '',
    email: chosen ? String(chosen.email).toLowerCase().trim() : '',
    emailVerified: Boolean(chosen),
    name: String(info.name || info.login || '').trim()
  };
}

// Trades the callback `code` for the person's identity. Resolves with
// { provider, providerId, email, emailVerified, name }; throws OAuthError.
async function fetchProfile(id, code, { verifier = '', fetchImpl = globalThis.fetch } = {}) {
  if (!isEnabled(id)) throw new OAuthError(`${providerLabel(id)} sign-in is not available right now.`);
  if (typeof fetchImpl !== 'function') throw new OAuthError('Sign-in is not available on this server right now.');
  const accessToken = await exchangeCode(id, code, { verifier, fetchImpl });
  const profile = id === 'google' ? await googleProfile(accessToken, fetchImpl) : await githubProfile(accessToken, fetchImpl);
  if (!profile.providerId) throw new OAuthError('The sign-in provider did not return an account id. Please try again.');
  return profile;
}

module.exports = {
  OAuthError,
  PROVIDERS,
  isKnownProvider,
  isEnabled,
  enabledProviders,
  providerLabel,
  redirectUri,
  newAttempt,
  statesMatch,
  buildAuthorizeUrl,
  fetchProfile
};
