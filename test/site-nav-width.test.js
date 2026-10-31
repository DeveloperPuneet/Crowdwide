// Regression: the public header used `width: 100vw`, which ignores the scrollbar,
// so "Join Crowdwide" sat flush against (or past) the screen edge and the page
// scrolled sideways. The header must size from its parent, never from 100vw.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('the public .site-nav is never sized with 100vw', () => {
  for (const name of ['style.css', 'modern-ui.css', 'responsive-layout.css']) {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/(^|\})\s*([^{}]*\.site-nav[^{}]*)\{([^{}]*)\}/g)) {
      assert.ok(!/(^|;|\s)width\s*:\s*100vw/.test(m[3]), `${name}: ${m[2].trim()} uses width:100vw`);
    }
  }
});
