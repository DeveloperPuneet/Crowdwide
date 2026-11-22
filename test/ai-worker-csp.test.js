const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const createApp = require('../src/app');

test('CSP no longer permits an inference worker or WebAssembly evaluation', async () => {
  const app = createApp({ port: 3000 });
  const page = await request(app).get('/docs');
  const pagePolicy = page.headers['content-security-policy'];
  assert.doesNotMatch(pagePolicy, /script-src[^;]*blob:/);
  assert.doesNotMatch(pagePolicy, /wasm-unsafe-eval/);
});
