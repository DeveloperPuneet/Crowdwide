const test = require('node:test');
const assert = require('node:assert/strict');
const { renderMentions } = require('../src/services/mentions');

test('renderMentions escapes content and links handles', () => {
  const rendered = renderMentions('<script>alert(1)</script> @Alice_1');
  assert.match(rendered, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(rendered, /href="\/search\?q=%40alice_1"/);
  assert.match(rendered, />@Alice_1<\/a>/);
});
