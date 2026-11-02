const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.ASSET_BUNDLE = 'on';
const assets = require('../src/services/assets');
const createApp = require('../src/app');

const root = path.join(__dirname, '..');

test('CSS bundles contain every stylesheet in the original cascade order', () => {
  const urls = assets.cssBundleUrls();
  assert.match(urls.base, /^\/css\/bundle-base\.css\?v=[0-9a-f]{10}$/);
  const head = fs.readFileSync(path.join(root, 'src/views/partials/head.ejs'), 'utf8');
  const fallback = [...head.matchAll(/href="\/css\/([a-z-]+)\.css"/g)].map((m) => m[1]).filter((n) => n !== 'community-workspace');
  assert.deepEqual([...assets.BUNDLES.base, ...assets.BUNDLES.polish], fallback);
});

test('bundles are served compressed with a one-year immutable cache when versioned', async () => {
  const app = createApp({ port: 3000 });
  const url = assets.cssBundleUrls().base;
  const res = await request(app).get(url).set('Accept-Encoding', 'gzip');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/css/);
  assert.match(res.headers['cache-control'], /immutable/);
  assert.equal(res.headers['content-encoding'], 'gzip');
  const again = await request(app).get('/css/bundle-base.css').set('Accept-Encoding', 'gzip');
  assert.equal(again.headers['cache-control'], 'no-cache');
});

test('versioned JS is cached for a year, unversioned static files still revalidate', async () => {
  const app = createApp({ port: 3000 });
  const versioned = await request(app).get(assets.asset('/js/app.js'));
  assert.match(versioned.headers['cache-control'], /max-age=31536000/);
  const plain = await request(app).get('/js/app.js');
  assert.doesNotMatch(plain.headers['cache-control'] || '', /immutable/);
});

test('reading stylesheet is part of the polish bundle', () => {
  assert.ok(assets.BUNDLES.polish.includes('reading'));
  assert.match(fs.readFileSync(path.join(root, 'public/css/reading.css'), 'utf8'), /--read-measure/);
});
