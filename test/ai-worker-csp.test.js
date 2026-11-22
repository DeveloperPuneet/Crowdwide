const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const createApp = require('../src/app');

test('only the on-device inference worker CSP permits blob module imports', async () => {
  const app = createApp({ port: 3000 });
  const [worker, page] = await Promise.all([
    request(app).get('/js/crowdwide-ai-worker.bundle.js'),
    request(app).get('/docs')
  ]);
  const workerPolicy = worker.headers['content-security-policy'];
  const pagePolicy = page.headers['content-security-policy'];

  assert.match(workerPolicy, /script-src[^;]*blob:/);
  assert.doesNotMatch(pagePolicy, /script-src[^;]*blob:/);
});
