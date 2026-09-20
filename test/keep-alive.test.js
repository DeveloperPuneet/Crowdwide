const test = require('node:test');
const assert = require('node:assert/strict');
const keep = require('../src/services/keepAlive');

test('resolveTarget builds the /health URL and skips local addresses', () => {
  assert.equal(keep.resolveTarget({ APP_URL: 'https://crowdwide.run.place' }), 'https://crowdwide.run.place/health');
  assert.equal(keep.resolveTarget({ KEEP_ALIVE_URL: 'https://x.io/app/', APP_URL: 'https://y.io' }), 'https://x.io/app/health');
  assert.equal(keep.resolveTarget({ APP_URL: 'https://x.io/health' }), 'https://x.io/health');
  assert.equal(keep.resolveTarget({ APP_URL: 'http://localhost:3000' }), null);
  assert.equal(keep.resolveTarget({ APP_URL: 'http://localhost:3000', KEEP_ALIVE_ENABLED: 'true' }), 'http://localhost:3000/health');
  assert.equal(keep.resolveTarget({}), null);
  assert.equal(keep.resolveTarget({ APP_URL: 'not a url' }), null);
});

test('isEnabled: on in production, off elsewhere, overridable', () => {
  assert.equal(keep.isEnabled({ NODE_ENV: 'production' }), true);
  assert.equal(keep.isEnabled({ NODE_ENV: 'development' }), false);
  assert.equal(keep.isEnabled({ NODE_ENV: 'production', KEEP_ALIVE_ENABLED: 'false' }), false);
  assert.equal(keep.isEnabled({ NODE_ENV: 'development', KEEP_ALIVE_ENABLED: 'true' }), true);
});

test('startKeepAlive schedules the cron and pings /health', async () => {
  keep.stopKeepAlive();
  const scheduled = [];
  const cronImpl = { validate: () => true, schedule: (expr, fn) => { scheduled.push(expr); return { stop() {}, fn }; } };
  const urls = [];
  const task = keep.startKeepAlive({ env: { NODE_ENV: 'production', APP_URL: 'https://x.io', KEEP_ALIVE_CRON: '*/5 * * * *' }, cronImpl, mongoose: { connection: { readyState: 0 } }, fetchImpl: async (url) => { urls.push(url); return { status: 200 }; } });
  assert.deepEqual(scheduled, ['*/5 * * * *']);
  const result = await task.runNow();
  assert.deepEqual(urls, ['https://x.io/health']);
  assert.equal(result.web.ok, true);
  keep.stopKeepAlive();
});

test('pingOnce reports failures and 5xx as not ok', async () => {
  assert.equal((await keep.pingOnce('https://x/health', { fetchImpl: async () => ({ status: 503 }) })).ok, false);
  const failed = await keep.pingOnce('https://x/health', { fetchImpl: async () => { throw new Error('boom'); } });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'boom');
});
