// WideWave names: ww/<name>, unique, lowercase letters, numbers and underscores, 3-30 characters.
const RESERVED = new Set(['new', 'all', 'popular', 'trending', 'leaderboard', 'search', 'create', 'edit', 'delete', 'admin', 'moderator', 'mod', 'crowdwide', 'official', 'support', 'help', 'api', 'null', 'undefined', 'home', 'explore', 'feed', 'mine']);
const PATTERN = /^[a-z0-9_]{3,30}$/;

// "ww/Art", " WW/art " and "#art" all normalise to "art".
function normalizeWideWaveName(input = '') {
  return String(input).trim().toLowerCase().replace(/^\/?ww\//, '').replace(/^[#/]+/, '');
}

function validateWideWaveName(input = '') {
  const name = normalizeWideWaveName(input);
  if (!PATTERN.test(name)) return { ok: false, error: 'Use 3-30 letters, numbers or underscores after ww/ (for example ww/poetry).' };
  if (/^_|_$/.test(name) || /^\d+$/.test(name)) return { ok: false, error: 'A WideWave name cannot be only numbers or start or end with an underscore.' };
  if (RESERVED.has(name)) return { ok: false, error: `ww/${name} is reserved. Choose another name.` };
  return { ok: true, name };
}

module.exports = { normalizeWideWaveName, validateWideWaveName, RESERVED, PATTERN };
