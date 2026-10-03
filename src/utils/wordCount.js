module.exports = function countWords(value) {
  const trimmed = String(value || '').trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
};
