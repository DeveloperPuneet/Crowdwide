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

function freshTranslate() {
  delete require.cache[require.resolve('../src/services/translate')];
  return require('../src/services/translate');
}

test('translationConfigured is false with neither provider set', () => {
  withEnv({ GOOGLE_TRANSLATE_API_KEY: undefined, LIBRETRANSLATE_URL: undefined }, () => {
    const translate = freshTranslate();
    assert.equal(translate.translationConfigured(), false);
  });
});

test('translateText returns null (not configured) with no provider, without ever calling fetch', async () => {
  await withEnv({ GOOGLE_TRANSLATE_API_KEY: undefined, LIBRETRANSLATE_URL: undefined }, async () => {
    const translate = freshTranslate();
    const result = await translate.translateText('hello', 'es', { fetchImpl: async () => { throw new Error('should not fetch'); } });
    assert.equal(result, null);
  });
});

test('translateText with empty text or no target returns null even when configured', async () => {
  await withEnv({ GOOGLE_TRANSLATE_API_KEY: 'k' }, async () => {
    const translate = freshTranslate();
    assert.equal(await translate.translateText('   ', 'es'), null);
    assert.equal(await translate.translateText('hi', ''), null);
  });
});

test('Google provider: sends the right request and parses the response', async () => {
  await withEnv({ GOOGLE_TRANSLATE_API_KEY: 'secret-key', LIBRETRANSLATE_URL: undefined }, async () => {
    const translate = freshTranslate();
    let captured;
    const fetchImpl = async (url, options) => {
      captured = { url, body: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ data: { translations: [{ translatedText: 'Hola', detectedSourceLanguage: 'en' }] } }) };
    };
    const result = await translate.translateText('Hello', 'es', { fetchImpl });
    assert.match(captured.url, /translation\.googleapis\.com/);
    assert.match(captured.url, /key=secret-key/);
    assert.equal(captured.body.q, 'Hello');
    assert.equal(captured.body.target, 'es');
    assert.deepEqual(result, { translatedText: 'Hola', detectedSourceLanguage: 'en' });
  });
});

test('LibreTranslate (the free, self-hosted provider) is preferred over Google when both are configured', async () => {
  await withEnv({ GOOGLE_TRANSLATE_API_KEY: 'k', LIBRETRANSLATE_URL: 'https://libre.example' }, async () => {
    const translate = freshTranslate();
    let hitLibre = false;
    const fetchImpl = async (url) => { hitLibre = url.includes('libre.example'); return { ok: true, json: async () => ({ translatedText: 'x' }) }; };
    await translate.translateText('hi', 'fr', { fetchImpl });
    assert.equal(hitLibre, true);
  });
});

test('Google Translate is used when LibreTranslate fails and Google is configured', async () => {
  await withEnv({ GOOGLE_TRANSLATE_API_KEY: 'google-key', LIBRETRANSLATE_URL: 'https://libre.example' }, async () => {
    const translate = freshTranslate();
    const requestedUrls = [];
    const fetchImpl = async (url) => {
      requestedUrls.push(url);
      if (url.includes('libre.example')) return { ok: false, status: 503 };
      return { ok: true, json: async () => ({ data: { translations: [{ translatedText: 'Hola' }] } }) };
    };
    const result = await translate.translateText('Hello', 'es', { fetchImpl });
    assert.deepEqual(result, { translatedText: 'Hola', detectedSourceLanguage: null });
    assert.deepEqual(requestedUrls, [
      'https://libre.example/translate',
      'https://translation.googleapis.com/language/translate2?key=google-key'
    ]);
  });
});

test('translationIsFree is true only when the free, self-hosted LibreTranslate provider is configured', async () => {
  await withEnv({ GOOGLE_TRANSLATE_API_KEY: undefined, LIBRETRANSLATE_URL: undefined }, async () => {
    assert.equal(freshTranslate().translationIsFree(), false);
  });
  await withEnv({ GOOGLE_TRANSLATE_API_KEY: 'k', LIBRETRANSLATE_URL: undefined }, async () => {
    assert.equal(freshTranslate().translationIsFree(), false);
  });
  await withEnv({ GOOGLE_TRANSLATE_API_KEY: undefined, LIBRETRANSLATE_URL: 'https://libre.example' }, async () => {
    assert.equal(freshTranslate().translationIsFree(), true);
  });
  await withEnv({ GOOGLE_TRANSLATE_API_KEY: 'k', LIBRETRANSLATE_URL: 'https://libre.example' }, async () => {
    assert.equal(freshTranslate().translationIsFree(), false);
  });
});

test('LibreTranslate provider: sends the right request and parses the response', async () => {
  await withEnv({ GOOGLE_TRANSLATE_API_KEY: undefined, LIBRETRANSLATE_URL: 'https://libre.example/' }, async () => {
    const translate = freshTranslate();
    let captured;
    const fetchImpl = async (url, options) => { captured = { url, body: JSON.parse(options.body) }; return { ok: true, json: async () => ({ translatedText: 'Bonjour', detectedLanguage: { language: 'en' } }) }; };
    const result = await translate.translateText('Hello', 'fr', { fetchImpl });
    assert.equal(captured.url, 'https://libre.example/translate');
    assert.equal(captured.body.source, 'auto');
    assert.deepEqual(result, { translatedText: 'Bonjour', detectedSourceLanguage: 'en' });
  });
});

test('a non-ok response from either provider throws', async () => {
  await withEnv({ GOOGLE_TRANSLATE_API_KEY: 'k' }, async () => {
    const translate = freshTranslate();
    await assert.rejects(() => translate.translateText('hi', 'es', { fetchImpl: async () => ({ ok: false, status: 500 }) }));
  });
});

test('LANGUAGES is a non-empty, code/name curated list', () => {
  const translate = freshTranslate();
  assert.ok(translate.LANGUAGES.length > 10);
  assert.ok(translate.LANGUAGES.every(([code, name]) => /^[a-z]{2}$/.test(code) && typeof name === 'string'));
});
