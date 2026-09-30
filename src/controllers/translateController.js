const { translateText, translationConfigured, LANGUAGES } = require('../services/translate');
const logger = require('../services/logger');

// Free-form: translates whatever text the client already has on screen (a
// post body or a comment body the viewer can already see). No extra
// permission check is needed beyond being signed in - the text isn't looked
// up from the database, so this can't be used to read something the viewer
// couldn't already read.
exports.translate = async (req, res) => {
  if (!translationConfigured()) return res.status(503).json({ ok: false, error: 'Translation is not configured on this deployment.' });
  const text = String(req.body.text || '').slice(0, 5000);
  const target = String(req.body.target || '').trim().toLowerCase();
  const source = req.body.source ? String(req.body.source).trim().toLowerCase() : undefined;
  if (!text.trim() || !/^[a-z]{2}(-[a-z]{2})?$/.test(target)) return res.status(400).json({ ok: false, error: 'Add some text and a target language.' });
  try {
    const result = await translateText(text, target, { source });
    if (!result) return res.status(503).json({ ok: false, error: 'Translation is not configured on this deployment.' });
    res.json({ ok: true, translatedText: result.translatedText, detectedSourceLanguage: result.detectedSourceLanguage });
  } catch (error) {
    logger.error('Translation request failed', error);
    res.status(502).json({ ok: false, error: 'Translation failed. Try again in a moment.' });
  }
};

exports.languages = (req, res) => res.json({ ok: true, configured: translationConfigured(), languages: LANGUAGES.map(([code, name]) => ({ code, name })) });
