const test = require('node:test');
const assert = require('node:assert/strict');

// Gmail credentials present, MAIL_PROVIDER deliberately NOT set: this used to
// mean "mail not configured" and every email was silently dropped into the log.
process.env.GMAIL_USER = 'sender@gmail.com';
process.env.GOOGLE_CLIENT_ID = 'client-id';
process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
process.env.GOOGLE_REFRESH_TOKEN = 'refresh-token';
delete process.env.MAIL_PROVIDER;
delete process.env.MAIL_TRANSPORT;
delete process.env.MAIL_HOST;

const nodemailer = require('nodemailer');
const { sendVerificationCode, verifyMailConfig, explainMailError } = require('../src/services/mailer');

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('Gmail credentials alone are enough: mail goes out over the HTTPS Gmail API, not SMTP', async (t) => {
  const smtp = t.mock.method(nodemailer, 'createTransport', () => { throw new Error('SMTP must not be used'); });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (String(url).includes('oauth2.googleapis.com')) return jsonResponse(200, { access_token: 'access-1', expires_in: 3600 });
    return jsonResponse(200, { id: 'msg-1' });
  });

  await sendVerificationCode({ email: 'pat@example.com' }, '246810');

  assert.equal(smtp.mock.callCount(), 0);
  const send = calls.find((call) => String(call.url).includes('gmail.googleapis.com'));
  assert.ok(send, 'expected a Gmail API send request');
  assert.equal(send.options.headers.Authorization, 'Bearer access-1');
  const raw = Buffer.from(JSON.parse(send.options.body).raw, 'base64url').toString('utf8');
  assert.match(raw, /To: pat@example\.com/);
  assert.match(raw, /246810/);
});

test('a stale cached token (401) is refreshed once and the send is retried', async (t) => {
  let tokenCalls = 0;
  let sendCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('oauth2.googleapis.com')) { tokenCalls += 1; return jsonResponse(200, { access_token: `access-${tokenCalls}`, expires_in: 3600 }); }
    sendCalls += 1;
    return sendCalls === 1 ? jsonResponse(401, { error: { message: 'Invalid Credentials' } }) : jsonResponse(200, { id: 'ok' });
  });
  await verifyMailConfig(); // forces a token fetch, seeding the cache
  tokenCalls = 0;
  await sendVerificationCode({ email: 'pat@example.com' }, '111111');
  assert.equal(sendCalls, 2);
  assert.ok(tokenCalls >= 1);
});

test('an expired refresh token never throws out of sendVerificationCode, and the log hint explains why', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }));
  await assert.doesNotReject(sendVerificationCode({ email: 'pat@example.com' }, '222222'));
  const result = await verifyMailConfig();
  assert.equal(result.ok, false);
  assert.match(result.detail, /Testing/);
});

test('a hanging mail provider cannot hold a request open (fetch is aborted, error swallowed)', async (t) => {
  process.env.MAIL_TIMEOUT_MS = '50';
  // MAIL_TIMEOUT_MS is read at module load, so load a fresh copy of the mailer.
  delete require.cache[require.resolve('../src/services/mailer')];
  const fresh = require('../src/services/mailer');
  t.mock.method(globalThis, 'fetch', (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
  const started = Date.now();
  await assert.doesNotReject(fresh.sendVerificationCode({ email: 'pat@example.com' }, '333333'));
  assert.ok(Date.now() - started < 2000, 'send should give up quickly');
  delete process.env.MAIL_TIMEOUT_MS;
});

test('explainMailError gives actionable hints', () => {
  assert.match(explainMailError(new Error('connect ETIMEDOUT 142.250.0.1:465')), /block outbound SMTP/);
  assert.match(explainMailError(Object.assign(new Error('x'), { googleError: 'invalid_client' })), /CLIENT_ID/);
  assert.match(explainMailError(new Error('Gmail API has not been used in project 123')), /Enable "Gmail API"/);
});
