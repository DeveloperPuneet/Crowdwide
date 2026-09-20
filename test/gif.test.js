const test = require('node:test');
const assert = require('node:assert/strict');
const gif = require('../src/services/gif');

test('only https GIPHY CDN URLs are accepted as GIFs', () => {
  assert.equal(gif.isAllowedGifUrl('https://media.giphy.com/media/abc/giphy.gif'), true);
  assert.equal(gif.isAllowedGifUrl('https://media3.giphy.com/x.gif'), true);
  assert.equal(gif.isAllowedGifUrl('https://i.giphy.com/x.gif'), true);
  for (const bad of ['http://media.giphy.com/x.gif', 'https://evil.com/x.gif', 'https://media.giphy.com.evil.com/x.gif', 'https://user:pw@media.giphy.com/x.gif', 'javascript:alert(1)', '', null, 'https://giphy.com/x.gif']) {
    assert.equal(gif.isAllowedGifUrl(bad), false, String(bad));
  }
});

test('sanitizeGif / gifFromBody keep clean fields and drop invalid GIFs', () => {
  const clean = gif.gifFromBody({ gifUrl: 'https://media.giphy.com/a.gif', gifPreview: 'https://evil.com/p.gif', gifTitle: '  cats \n playing  ', gifWidth: '200', gifHeight: 'abc' });
  assert.equal(clean.url, 'https://media.giphy.com/a.gif');
  assert.equal(clean.preview, clean.url, 'a disallowed preview falls back to the main URL');
  assert.equal(clean.title, 'cats playing');
  assert.equal(clean.width, 200);
  assert.equal(clean.height, undefined);
  assert.equal(gif.gifFromBody({ gifUrl: 'https://evil.com/a.gif' }), null);
  assert.equal(gif.gifFromBody({}), null);
});

test('searchGifs needs a key, normalizes results, and caches', async () => {
  gif.clearGifCache();
  await assert.rejects(() => gif.searchGifs({ q: 'x', env: {} }), { code: 'GIF_NOT_CONFIGURED' });
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    assert.match(url, /\/search\?/);
    assert.match(url, /api_key=KEY/);
    return { ok: true, status: 200, json: async () => ({ data: [
      { id: '1', title: 'One', images: { fixed_width: { url: 'https://media.giphy.com/1.gif', width: '200', height: '150' }, fixed_width_small: { url: 'https://media.giphy.com/1s.gif' } } },
      { id: '2', title: 'Bad host', images: { fixed_width: { url: 'https://evil.com/2.gif' } } }
    ], pagination: { total_count: 50 } }) };
  };
  const env = { GIPHY_API_KEY: 'KEY' };
  const first = await gif.searchGifs({ q: 'Cats', env, fetchImpl });
  assert.equal(first.results.length, 1, 'results from other hosts are dropped');
  assert.equal(first.results[0].preview, 'https://media.giphy.com/1s.gif');
  assert.equal(first.next, 2);
  await gif.searchGifs({ q: 'cats', env, fetchImpl });
  assert.equal(calls, 1, 'same query is served from cache');
  await assert.rejects(() => gif.searchGifs({ q: 'dogs', env, fetchImpl: async () => ({ ok: false, status: 429 }) }), { code: 'GIF_RATE_LIMITED' });
});

test('gifsEnabled follows GIPHY_API_KEY', () => {
  assert.equal(gif.gifsEnabled({}), false);
  assert.equal(gif.gifsEnabled({ GIPHY_API_KEY: ' ' }), false);
  assert.equal(gif.gifsEnabled({ GIPHY_API_KEY: 'k' }), true);
});
