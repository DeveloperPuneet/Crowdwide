// Plain-text previews of user-written posts.
//
// Posts are authored with light markdown (**bold**, *italic*, "# heading",
// "- item", fenced code) and rendered rich on the post page. Everywhere that
// only shows a short snippet (feeds, search, emails, quoted posts) the raw
// markers used to leak through ("**", "```", "# ") and snippets were cut at a
// fixed character count, which could split an emoji in half.

function plainText(text = '') {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    // fenced code (also an unclosed fence) becomes a short marker
    .replace(/(^|\n) {0,3}```[^\n]*\n[\s\S]*?(?:\n {0,3}```[ \t]*(?=\n|$)|$)/g, '$1[code]\n')
    .replace(/^ {0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*[-*][ \t]+/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
    .replace(/`{3,}/g, '')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// Truncates on code points (never splits an emoji) and, when possible, on a
// word boundary. Returns the text unchanged when it already fits.
function preview(text = '', max = 140) {
  const plain = plainText(text);
  const chars = Array.from(plain);
  if (chars.length <= max) return plain;
  let cut = chars.slice(0, max).join('');
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > cut.length - 24 && lastSpace > 0) cut = cut.slice(0, lastSpace);
  return `${cut.replace(/[\s.,;:!?-]+$/, '')}…`;
}

module.exports = { plainText, preview };
