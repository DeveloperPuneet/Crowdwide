// Post and comment translation. Works out of the box with NO setup and NO
// API key: with nothing configured it uses free public endpoints. Optional
// providers can be added for more capacity/quality.
//
// Order tried (first success wins):
//   1. LIBRETRANSLATE_URL       - optional self-hosted LibreTranslate (free, open source).
//   2. GOOGLE_TRANSLATE_API_KEY - optional paid Google Cloud Translation v2.
//   3. Free built-in (no key): Google's public web-translate endpoint, then
//      MyMemory as a backup. Set TRANSLATE_FREE_FALLBACK=off to disable these.
const TIMEOUT_MS = 8000;

// Curated list for the language picker in the UI - not exhaustive, but covers
// what a translation provider supports and keeps the dropdown short.
const LANGUAGES = [
  ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'],
  ['pt', 'Portuguese'], ['it', 'Italian'], ['nl', 'Dutch'], ['pl', 'Polish'],
  ['ru', 'Russian'], ['uk', 'Ukrainian'], ['tr', 'Turkish'], ['ar', 'Arabic'],
  ['hi', 'Hindi'], ['bn', 'Bengali'], ['ur', 'Urdu'], ['pa', 'Punjabi'],
  ['ta', 'Tamil'], ['te', 'Telugu'], ['mr', 'Marathi'], ['gu', 'Gujarati'],
  ['zh', 'Chinese'], ['ja', 'Japanese'], ['ko', 'Korean'], ['vi', 'Vietnamese'],
  ['th', 'Thai'], ['id', 'Indonesian'], ['sw', 'Swahili']
];

function googleConfigured() { return Boolean(process.env.GOOGLE_TRANSLATE_API_KEY); }
function libreConfigured() { return Boolean(process.env.LIBRETRANSLATE_URL); }
function freeFallbackEnabled() { return String(process.env.TRANSLATE_FREE_FALLBACK || 'on').toLowerCase() !== 'off'; }
function translationConfigured() { return googleConfigured() || libreConfigured() || freeFallbackEnabled(); }
// True when translation can never hit the paid provider.
function translationIsFree() { return !googleConfigured(); }

// Split long text into chunks at paragraph/sentence/space boundaries.
function chunkText(text, max) {
  if (text.length <= max) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
    if (cut < max * 0.3) cut = window.lastIndexOf(' ');
    if (cut < 1) cut = max - 1;
    chunks.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function translateViaFreeGoogle(text, target, source, fetchImpl) {
  const parts = [];
  let detected = null;
  for (const chunk of chunkText(text, 1500)) {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=${encodeURIComponent(source || 'auto')}&tl=${encodeURIComponent(target)}&q=${encodeURIComponent(chunk)}`;
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Free Google endpoint responded ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data?.[0])) throw new Error('Free Google endpoint returned no translation');
    parts.push(data[0].map((segment) => segment?.[0] || '').join(''));
    detected = detected || (typeof data[2] === 'string' ? data[2] : null);
  }
  return { translatedText: parts.join(''), detectedSourceLanguage: detected || source || null };
}

async function translateViaMyMemory(text, target, source, fetchImpl) {
  const parts = [];
  for (const chunk of chunkText(text, 450)) {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=${encodeURIComponent(source || 'Autodetect')}|${encodeURIComponent(target)}`;
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error(`MyMemory responded ${response.status}`);
    const data = await response.json();
    const out = data?.responseData?.translatedText;
    if (!out || Number(data.responseStatus) !== 200) throw new Error('MyMemory returned no translation');
    parts.push(out);
  }
  return { translatedText: parts.join(''), detectedSourceLanguage: source || null };
}

async function translateViaGoogle(text, target, source, fetchImpl) {
  const url = `https://translation.googleapis.com/language/translate2?key=${encodeURIComponent(process.env.GOOGLE_TRANSLATE_API_KEY)}`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: text, target, ...(source ? { source } : {}), format: 'text' }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`Google Translate responded ${response.status}`);
  const data = await response.json();
  const result = data?.data?.translations?.[0];
  if (!result) throw new Error('Google Translate returned no translation');
  return { translatedText: result.translatedText, detectedSourceLanguage: result.detectedSourceLanguage || source || null };
}

async function translateViaLibre(text, target, source, fetchImpl) {
  const base = String(process.env.LIBRETRANSLATE_URL).replace(/\/$/, '');
  const response = await fetchImpl(`${base}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: text, source: source || 'auto', target, format: 'text', ...(process.env.LIBRETRANSLATE_API_KEY ? { api_key: process.env.LIBRETRANSLATE_API_KEY } : {}) }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!response.ok) {
    const authHint = response.status === 401 || response.status === 403
      ? '; check LIBRETRANSLATE_API_KEY and confirm LIBRETRANSLATE_URL points to LibreTranslate, not the Crowdwide website'
      : '';
    throw new Error(`LibreTranslate responded ${response.status}${authHint}`);
  }
  const data = await response.json();
  if (!data?.translatedText) throw new Error('LibreTranslate returned no translation');
  return { translatedText: data.translatedText, detectedSourceLanguage: data.detectedLanguage?.language || (source !== 'auto' ? source : null) };
}

// Returns { translatedText, detectedSourceLanguage } or null if translation
// isn't configured. Throws on a provider error (caller decides how to surface it).
async function translateText(text, target, { source, fetchImpl = fetch } = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed || !target) return null;
  const attempts = [];
  if (libreConfigured()) attempts.push(translateViaLibre);
  if (googleConfigured()) attempts.push(translateViaGoogle);
  if (freeFallbackEnabled()) attempts.push(translateViaFreeGoogle, translateViaMyMemory);
  if (!attempts.length) return null;
  let lastError;
  for (const attempt of attempts) {
    try {
      return await attempt(trimmed, target, source, fetchImpl);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

module.exports = { translateText, freeFallbackEnabled, translationConfigured, translationIsFree, googleConfigured, libreConfigured, LANGUAGES };
