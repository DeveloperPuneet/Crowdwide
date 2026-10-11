const test = require('node:test');
const assert = require('node:assert/strict');
const { renderRichBody, renderInlineText } = require('../src/services/mentions');
const { plainText, preview } = require('../src/utils/textPreview');

test('plainText removes markdown markers and collapses code blocks', () => {
  assert.equal(plainText('# Title\n\n**Bold** and *soft* text\n- one\n- two'), 'Title Bold and soft text one two');
  assert.equal(plainText('Before\n\n```js\nconst a = 1;\n```\n\nAfter'), 'Before [code] After');
  assert.equal(plainText('Unclosed\n```\ncode here'), 'Unclosed [code]');
  assert.equal(plainText('Use `npm ci` here'), 'Use npm ci here');
});

test('preview never cuts an emoji in half and cuts on a word boundary', () => {
  const text = '😀'.repeat(10);
  assert.equal(preview(text, 5), '😀😀😀😀😀…');
  assert.equal(preview('The quick brown fox jumps over the lazy dog', 20), 'The quick brown fox…');
  assert.equal(preview('Short text', 50), 'Short text');
  assert.equal(preview(null, 10), '');
});

test('renderRichBody turns plain URLs into safe external links', () => {
  const html = renderRichBody('Read https://example.com/a?x=1&y=2, then reply.');
  assert.match(html, /<a class="auto-link" href="https:\/\/example\.com\/a\?x=1&amp;y=2" target="_blank" rel="noopener noreferrer nofollow ugc">/);
  assert.match(html, /<\/a>, then reply\./);
});

test('links do not swallow trailing punctuation or bold markers', () => {
  assert.match(renderRichBody('(see https://example.com/page).'), /href="https:\/\/example\.com\/page"[^>]*>https:\/\/example\.com\/page<\/a>\)\./);
  assert.match(renderRichBody('**https://example.com/x**'), /<strong><a [^>]*href="https:\/\/example\.com\/x"/);
  assert.match(renderRichBody('https://en.wikipedia.org/wiki/Foo_(bar)'), /href="https:\/\/en\.wikipedia\.org\/wiki\/Foo_\(bar\)"/);
});

test('very long links are shortened for display but keep the full href', () => {
  const url = `https://example.com/${'a'.repeat(120)}`;
  const html = renderRichBody(url);
  assert.ok(html.includes(`href="${url}"`));
  assert.match(html, />https:\/\/example\.com\/a+…<\/a>/);
});

test('only http(s) links are created and nothing can break out of the href', () => {
  assert.doesNotMatch(renderRichBody('javascript:alert(1) and ftp://x.test'), /<a /);
  const html = renderRichBody('https://example.com/"><script>x</script>');
  assert.doesNotMatch(html, /<script>/);
});

test('#hashtags link to search, headings and numbers do not', () => {
  assert.match(renderRichBody('Loving #NodeJS today'), /<a class="hashtag-link" href="\/search\?q=%23nodejs">#NodeJS<\/a>/);
  assert.doesNotMatch(renderRichBody('Issue #123 is open'), /hashtag-link/);
  assert.equal(renderRichBody('# A heading'), '<h3>A heading</h3>');
});

test('mentions still work next to links and are not double-linked', () => {
  const html = renderRichBody('Thanks @alice https://example.com/@alice');
  assert.equal((html.match(/mention-link/g) || []).length, 1);
  assert.equal((html.match(/auto-link/g) || []).length, 1);
});

test('comments and chat get links, hashtags and mentions but no block markup', () => {
  const html = renderInlineText('hi @bob **not bold** #fun https://example.com');
  assert.match(html, /mention-link/);
  assert.match(html, /hashtag-link/);
  assert.match(html, /auto-link/);
  assert.doesNotMatch(html, /<strong>|<p>/);
});
