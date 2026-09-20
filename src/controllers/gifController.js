const { searchGifs } = require('../services/gif');

// GET /gifs/search?q=cats&pos=24  ->  { results: [{ id, title, url, preview, width, height }], next }
// With no `q` it returns trending GIFs.
exports.search = async (req, res) => {
  try {
    res.json(await searchGifs({ q: req.query.q, offset: req.query.pos }));
  } catch (error) {
    const messages = {
      GIF_NOT_CONFIGURED: [501, 'GIFs are not set up on this server yet.'],
      GIF_RATE_LIMITED: [429, 'GIF search is busy right now. Try again in a moment.'],
      GIF_TIMEOUT: [504, 'GIF search took too long. Try again.']
    };
    const [status, message] = messages[error.code] || [502, 'GIF search is unavailable right now.'];
    res.status(status).json({ results: [], next: null, error: message });
  }
};
