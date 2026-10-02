// Post and comment translation. Pluggable, like the mailer: pick whichever
// provider is configured and degrade to "unavailable" with none set, rather
// than failing the page.
//
//   LIBRETRANSLATE_URL         - a self-hosted LibreTranslate base URL
//                                (https://github.com/LibreTranslate/LibreTranslate).
//                                Free and open-source; hosting still requires
//                                compute resources. See DEPLOYMENT.md. Add
//                                LIBRETRANSLATE_API_KEY if the instance requires it.
//   GOOGLE_TRANSLATE_API_KEY   - Google Cloud Translation API v2, as a paid
//                                fallback. Billed per character by Google -
//                                not free. https://cloud.google.com/translate
//
// LibreTranslate is tried first; Google is used only if it fails and a key is set.
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
function translationConfigured() { return googleConfigured() || libreConfigured(); }
// True only when configured translation cannot fall back to the paid provider.
function translationIsFree() { return libreConfigured() && !googleConfigured(); }

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
  if (!response.ok) throw new Error(`LibreTranslate responded ${response.status}`);
  const data = await response.json();
  if (!data?.translatedText) throw new Error('LibreTranslate returned no translation');
  return { translatedText: data.translatedText, detectedSourceLanguage: data.detectedLanguage?.language || (source !== 'auto' ? source : null) };
}

// Returns { translatedText, detectedSourceLanguage } or null if translation
// isn't configured. Throws on a provider error (caller decides how to surface it).
async function translateText(text, target, { source, fetchImpl = fetch } = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed || !target) return null;
  if (libreConfigured()) {
    try {
      return await translateViaLibre(trimmed, target, source, fetchImpl);
    } catch (error) {
      if (!googleConfigured()) throw error;
    }
  }
  if (googleConfigured()) return translateViaGoogle(trimmed, target, source, fetchImpl);
  return null;
}

module.exports = { translateText, translationConfigured, translationIsFree, googleConfigured, libreConfigured, LANGUAGES };
