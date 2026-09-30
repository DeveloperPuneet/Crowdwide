const test = require('node:test');
const assert = require('node:assert/strict');
const environment = require('../src/services/environment');

function withEnv(values, fn) {
  const previous = {};
  for (const key of Object.keys(values)) { previous[key] = process.env[key]; if (values[key] === undefined) delete process.env[key]; else process.env[key] = values[key]; }
  try { return fn(); } finally { for (const key of Object.keys(previous)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } }
}

test('outside staging every recipient is allowed', () => {
  withEnv({ APP_ENV: undefined, STAGING_MAIL_ALLOWLIST: undefined }, () => {
    assert.equal(environment.isStaging(), false);
    assert.equal(environment.mailAllowed('anyone@example.com'), true);
  });
});

test('in staging with no allowlist, no email is sent', () => {
  withEnv({ APP_ENV: 'staging', STAGING_MAIL_ALLOWLIST: undefined }, () => {
    assert.equal(environment.mailAllowed('anyone@example.com'), false);
  });
});

test('in staging, only allowlisted addresses and @domains receive email', () => {
  withEnv({ APP_ENV: 'Staging', STAGING_MAIL_ALLOWLIST: 'qa@team.com, @internal.dev' }, () => {
    assert.equal(environment.mailAllowed('QA@team.com'), true);
    assert.equal(environment.mailAllowed('Name <person@internal.dev>'), true);
    assert.equal(environment.mailAllowed('real.user@gmail.com'), false);
    assert.equal(environment.mailAllowed(['qa@team.com', 'real.user@gmail.com']), false);
  });
});

test('staging sets a noindex header and the banner flag; production does not', () => {
  const headers = {};
  const res = { setHeader: (k, v) => { headers[k] = v; }, locals: {} };
  withEnv({ APP_ENV: 'staging' }, () => environment.stagingMiddleware({}, res, () => {}));
  assert.equal(headers['X-Robots-Tag'], 'noindex, nofollow');
  assert.equal(res.locals.isStaging, true);
  const prodHeaders = {};
  const prodRes = { setHeader: (k, v) => { prodHeaders[k] = v; }, locals: {} };
  withEnv({ APP_ENV: 'production' }, () => environment.stagingMiddleware({}, prodRes, () => {}));
  assert.equal(prodHeaders['X-Robots-Tag'], undefined);
  assert.equal(prodRes.locals.isStaging, false);
});
