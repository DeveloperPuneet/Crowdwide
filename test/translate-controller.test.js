const test = require('node:test');
const assert = require('node:assert/strict');

// Async-safe: awaits fn() before restoring, so env vars stay set across every
// `await` inside fn (a plain try/finally around an async fn would restore them
// after the first await yields, not after fn actually finishes).
async function withEnv(values, fn) {
  const previous = {};
  for (const key of Object.keys(values)) { previous[key] = process.env[key]; if (values[key] === undefined) delete process.env[key]; else process.env[key] = values[key]; }
  try { return await fn(); } finally { for (const key of Object.keys(previous)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } }
}

function freshController() {
  delete require.cache[require.resolve('../src/services/translate')];
  delete require.cache[require.resolve('../src/controllers/translateController')];
  return require('../src/controllers/translateController');
}

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

test('returns 503 when no provider is configured', async () => {
  await withEnv({ GOOGLE_TRANSLATE_API_KEY: undefined, LIBRETRANSLATE_URL: undefined }, async () => {
    const controller = freshController();
    const res = mockRes();
    await controller.translate({ body: { text: 'hi', target: 'es' } }, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.ok, false);
  });
});

test('rejects missing text or a malformed target language code', async () => {
  await withEnv({ GOOGLE_TRANSLATE_API_KEY: 'k' }, async () => {
    const controller = freshController();
    const res1 = mockRes();
    await controller.translate({ body: { text: '   ', target: 'es' } }, res1);
    assert.equal(res1.statusCode, 400);
    const res2 = mockRes();
    await controller.translate({ body: { text: 'hi', target: 'not-a-lang!!' } }, res2);
    assert.equal(res2.statusCode, 400);
  });
});

test('a successful translation returns the translated text', async () => {
  await withEnv({ GOOGLE_TRANSLATE_API_KEY: 'k' }, async () => {
    const controller = freshController();
    const translateService = require('../src/services/translate');
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({ data: { translations: [{ translatedText: 'Hola', detectedSourceLanguage: 'en' }] } }) });
    const res = mockRes();
    await controller.translate({ body: { text: 'Hello', target: 'es' } }, res);
    global.fetch = originalFetch;
    assert.equal(res.body.ok, true);
    assert.equal(res.body.translatedText, 'Hola');
  });
});

test('a provider error surfaces as a 502 without leaking the internal error', async () => {
  await withEnv({ GOOGLE_TRANSLATE_API_KEY: 'k' }, async () => {
    const controller = freshController();
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error('network down'); };
    const res = mockRes();
    await controller.translate({ body: { text: 'Hello', target: 'es' } }, res);
    global.fetch = originalFetch;
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.ok, false);
    assert.ok(!res.body.error.includes('network down'));
  });
});

test('languages endpoint reports configured status and a language list', () => {
  const controller = freshController();
  const res = mockRes();
  controller.languages({}, res);
  assert.equal(res.body.ok, true);
  assert.ok(Array.isArray(res.body.languages) && res.body.languages.length > 0);
});
