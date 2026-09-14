const test = require('node:test');
const assert = require('node:assert/strict');
const { renderRichBody } = require('../src/services/mentions');

test('renderRichBody wraps a single line in one paragraph', () => {
  const html = renderRichBody('Just a normal short post.');
  assert.equal(html, '<p>Just a normal short post.</p>');
});

test('renderRichBody splits blank-line-separated text into separate paragraphs', () => {
  const html = renderRichBody('First paragraph.\n\nSecond paragraph.');
  assert.equal(html, '<p>First paragraph.</p><p>Second paragraph.</p>');
});

test('renderRichBody turns a single newline within a paragraph into a line break', () => {
  const html = renderRichBody('Line one\nLine two');
  assert.equal(html, '<p>Line one<br>Line two</p>');
});

test('renderRichBody renders a "# heading" line on its own as a heading, not a paragraph', () => {
  const html = renderRichBody('Intro paragraph.\n\n# A Heading\n\nMore text.');
  assert.equal(html, '<p>Intro paragraph.</p><h3>A Heading</h3><p>More text.</p>');
});

test('renderRichBody caps heading depth at h4 for ### and deeper', () => {
  assert.match(renderRichBody('## Two hashes'), /^<h4>Two hashes<\/h4>$/);
  assert.match(renderRichBody('### Three hashes'), /^<h4>Three hashes<\/h4>$/);
});

test('renderRichBody groups consecutive "- " lines into a bullet list', () => {
  const html = renderRichBody('- First\n- Second\n- Third');
  assert.equal(html, '<ul><li>First</li><li>Second</li><li>Third</li></ul>');
});

test('renderRichBody applies **bold** and *italic* inline formatting', () => {
  const html = renderRichBody('This is **bold** and this is *italic*.');
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
});

test('renderRichBody never lets user content inject real HTML tags (escapes before formatting)', () => {
  const html = renderRichBody('<img src=x onerror=alert(1)> and **<script>evil()</script>**');
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<script>evil/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  // the bold markers still wrap the escaped, inert text
  assert.match(html, /<strong>&lt;script&gt;evil\(\)&lt;\/script&gt;<\/strong>/);
});

test('renderRichBody still links @mentions inside rich text', () => {
  const html = renderRichBody('Thanks @Alice_1 for the help!');
  assert.match(html, /href="\/search\?q=%40alice_1"/);
  assert.match(html, />@Alice_1<\/a>/);
});

test('renderRichBody returns an empty string for empty input', () => {
  assert.equal(renderRichBody(''), '');
  assert.equal(renderRichBody('   \n\n   '), '');
});
