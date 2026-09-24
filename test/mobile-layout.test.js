// Regression test for a real bug: a mobile media query changed `position`
// from sticky/absolute to relative/static but left the inherited `top` (or
// `left`) offset in place, so the element still rendered shifted away from
// its layout box - visually overlapping the sibling that flows after it,
// even though the two boxes never actually touch in the CSS itself.
//
// This can't be caught by rendering markup (jsdom has no layout engine), so
// this walks the stylesheet text by hand (no CSS-parser dependency needed for
// something this narrow) and checks the cascade for every selector that ever
// leaves sticky/absolute/fixed positioning.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const files = ['style.css', 'responsive-media.css'].map((name) => ({
  name,
  text: fs.readFileSync(path.join(__dirname, '..', 'public', 'css', name), 'utf8')
}));

// Very small CSS walker: strips comments, then yields { selectors, decls,
// inMedia } for each rule, tracking whether it sits inside a @media block.
// Good enough for flat, non-nested stylesheets like this one - it doesn't
// need to understand selector matching beyond an exact string, since that's
// all the bug we're guarding against depends on.
function* rules(cssText) {
  const text = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  let mediaDepth = 0;
  let i = 0;
  while (i < text.length) {
    const atMedia = /^\s*@media[^{]*\{/.exec(text.slice(i));
    if (atMedia) { mediaDepth += 1; i += atMedia[0].length; continue; }
    const close = /^\s*\}/.exec(text.slice(i));
    if (close && mediaDepth > 0) { mediaDepth -= 1; i += close[0].length; continue; }
    const rule = /^\s*([^{}]+)\{([^{}]*)\}/.exec(text.slice(i));
    if (rule) {
      const selectors = rule[1].split(',').map((s) => s.trim());
      const decls = {};
      rule[2].split(';').forEach((part) => {
        const [prop, ...rest] = part.split(':');
        if (prop && rest.length) decls[prop.trim()] = rest.join(':').trim();
      });
      yield { selectors, decls, inMedia: mediaDepth > 0 };
      i += rule[0].length;
      continue;
    }
    i += 1; // whitespace / stray char between rules
  }
}

function declarationsFor(selector, prop) {
  const found = [];
  files.forEach(({ name, text }) => {
    for (const rule of rules(text)) {
      if (rule.selectors.includes(selector) && prop in rule.decls) found.push({ file: name, value: rule.decls[prop], inMedia: rule.inMedia });
    }
  });
  return found;
}

test('stylesheet parser sees the rules we expect (sanity check for the walker itself)', () => {
  assert.ok(declarationsFor('.settings-nav', 'position').length >= 2, 'expected a base rule plus at least one media-query override');
});

test('every rule that overrides position away from sticky/absolute/fixed also resets the offset that positioning used', () => {
  const positioned = new Set();
  files.forEach(({ text }) => {
    for (const rule of rules(text)) {
      if (['sticky', 'absolute', 'fixed'].includes(rule.decls.position)) rule.selectors.forEach((selector) => positioned.add(selector));
    }
  });
  const offenders = [];
  positioned.forEach((selector) => {
    const positions = declarationsFor(selector, 'position');
    const overridesAway = positions.some((d) => d.inMedia && (d.value === 'relative' || d.value === 'static'));
    if (!overridesAway) return; // this selector is never taken out of sticky/absolute - nothing to check
    ['top', 'left', 'right', 'bottom'].forEach((prop) => {
      const decls = declarationsFor(selector, prop);
      if (!decls.length) return; // no offset was ever set, so nothing can leak
      const last = decls[decls.length - 1];
      // The LAST declaration in cascade order for this offset must be a reset
      // (auto/0/unset), not an inherited sticky/absolute offset still in effect.
      if (!/^(auto|0(px)?|unset|initial)$/.test(last.value)) {
        offenders.push(`${selector} { ${prop} } - offset "${last.value}" from ${last.file} is still active after ${selector} becomes relative/static; it will visually shift the element off its layout box`);
      }
    });
  });
  assert.deepEqual(offenders, [], offenders.join('\n'));
});
