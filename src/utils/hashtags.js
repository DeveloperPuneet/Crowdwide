const TAG_PATTERN = /#([a-z0-9_]{2,30})/gi;

/** Pulls unique, lowercase #hashtags out of free text. Caps at 15 per piece of content. */
function extractHashtags(text = '') {
  const found = new Set();
  for (const match of String(text).matchAll(TAG_PATTERN)) {
    found.add(match[1].toLowerCase());
    if (found.size >= 15) break;
  }
  return Array.from(found);
}

/** Normalizes a comma/space separated hashtag input field (e.g. from a form) into a clean list. */
function parseHashtagList(input = '') {
  return Array.from(new Set(
    String(input)
      .split(/[,\s#]+/)
      .map((tag) => tag.trim().toLowerCase().replace(/[^a-z0-9_]/g, ''))
      .filter((tag) => tag.length >= 2 && tag.length <= 30)
  )).slice(0, 15);
}

module.exports = { extractHashtags, parseHashtagList };
