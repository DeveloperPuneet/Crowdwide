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

const files = ['style.css', 'responsive-media.css', 'responsive-layout.css'].map((name) => ({
  name,
  text: fs.readFileSync(path.join(__dirname, '..', 'public', 'css', name), 'utf8')
}));
const communityWorkspaceCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'community-workspace.css'), 'utf8');
const chatUiCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'chat-ui.css'), 'utf8');

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

test('dashboard columns fit common laptop widths and discovery does not spill below the feed on narrow layouts', () => {
  const responsive = files.find((file) => file.name === 'responsive-layout.css').text;
  assert.match(responsive, /\.app-layout\s*\{\s*grid-template-columns:\s*minmax\(180px,\s*230px\)\s+minmax\(0,\s*1fr\)\s+minmax\(220px,\s*330px\)/);
  assert.match(responsive, /@media\s*\(max-width:\s*1500px\)\s*\{[\s\S]*?\.app-layout,[\s\S]*?grid-template-columns:\s*minmax\(170px,\s*210px\)\s+minmax\(0,\s*1fr\)\s+minmax\(240px,\s*290px\)/);
  assert.match(responsive, /@media\s*\(max-width:\s*1024px\)\s*\{[\s\S]*?\.app-layout \.discover-column\s*\{\s*display:\s*none;/);
});

test('profile layout stops reserving a column when follow suggestions are hidden', () => {
  const responsive = files.find((file) => file.name === 'responsive-layout.css').text;
  const base = files.find((file) => file.name === 'style.css').text;

  assert.match(responsive, /@media\s*\(max-width:\s*1180px\)\s*\{[\s\S]*?\.profile-layout\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(260px,\s*300px\)/);
  assert.match(base, /@media\s*\(max-width:\s*1150px\)\s*\{[\s\S]*?\.discover-column\s*\{\s*display:\s*none/);
  assert.match(responsive, /@media\s*\(max-width:\s*1150px\)\s*\{\s*\.profile-layout\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

test('community detail collapses its sidebar column when responsive rules hide the sidebar', () => {
  assert.match(files.find((file) => file.name === 'style.css').text, /@media\s*\(max-width:\s*1150px\)\s*\{[\s\S]*?\.discover-column\s*\{\s*display:\s*none/);
  assert.match(communityWorkspaceCss, /@media\s*\(max-width:\s*1150px\)\s*\{\s*\.community-detail-layout\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(communityWorkspaceCss, /\.community-guidelines-copy\s*\{[^}]*white-space:\s*pre-wrap;[^}]*overflow-wrap:\s*anywhere/);
  assert.match(communityWorkspaceCss, /linear-gradient\(145deg,\s*var\(--sf-1\),\s*var\(--sf-0\)\)/);
});

test('chat selection controls use theme colors and reflow on narrow screens', () => {
  assert.match(chatUiCss, /\.chat-page \[data-chat-select-toggle\]\s*\{[^}]*background:\s*var\(--sf-2\);[^}]*color:\s*var\(--tx-hi\)/);
  assert.match(chatUiCss, /\.chat-page \.chat-selection-bar\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(chatUiCss, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.chat-page \.chat-selection-bar button\s*\{[^}]*flex:\s*1 1 0/);
  assert.match(files.find((file) => file.name === 'style.css').text, /\.chat-back, \.chat-header-action\s*\{[^}]*background:\s*transparent/);
});

test('audited page layouts provide narrow-screen and touch-friendly behavior', () => {
  const responsive = files.find((file) => file.name === 'responsive-layout.css').text;
  const base = files.find((file) => file.name === 'style.css').text;

  assert.match(responsive, /\.recap-stats\s*\{\s*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(responsive, /\.recap-chart\s*\{\s*overflow-x:\s*auto/);
  assert.match(responsive, /\.community-directory-grid,[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(responsive, /\.community-map-layout\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(responsive, /\.community-map-tools\s*\{[\s\S]*?flex-direction:\s*column/);
  assert.match(responsive, /\.admin-console \.admin-panel form\[style\*="display:flex"\][\s\S]*?flex-wrap:\s*wrap/);
  assert.match(responsive, /\.docs-table-wrap,[\s\S]*?overflow-x:\s*auto/);
  assert.match(base, /@media\s*\(max-width:\s*800px\)\s*\{[\s\S]*?\.auth-shell\s*\{\s*padding:\s*26px 0/);
  assert.match(responsive, /@media\s*\(max-width:\s*320px\)/);
  assert.match(responsive, /@media\s*\(max-height:\s*520px\)\s*and\s*\(orientation:\s*landscape\)/);
});

test('group, inbox, moderator, and community workspace actions reflow on narrow screens', () => {
  const responsive = files.find((file) => file.name === 'responsive-layout.css').text;

  assert.match(responsive, /\.group-info-head h1,[\s\S]*?overflow-wrap:\s*anywhere/);
  assert.match(responsive, /\.request-row\s*\{[\s\S]*?flex-wrap:\s*wrap/);
  assert.match(responsive, /\.request-row \.request-actions\s*\{[\s\S]*?width:\s*100%/);
  assert.match(responsive, /\.moderation-actions form\s*\{[\s\S]*?flex:\s*1 1 100%/);
  assert.match(responsive, /\.community-workspace-header\s*\{[\s\S]*?flex-wrap:\s*wrap/);
  assert.match(responsive, /\.community-owned-actions > \*\s*\{[\s\S]*?justify-content:\s*center/);
});

test('search filters, profile links, and recovery codes fit narrow phone layouts', () => {
  const base = files.find((file) => file.name === 'style.css').text;
  const responsive = files.find((file) => file.name === 'responsive-layout.css').text;

  assert.match(base, /\.search-filter-form\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(base, /\.search-filter-form > input\[type="search"\]\s*\{[^}]*grid-column:\s*span 2;[^}]*min-width:\s*0/);
  assert.match(base, /\.search-filter-toggles\s*\{[^}]*display:\s*flex;[^}]*grid-column:\s*span 2/);
  assert.match(base, /\.search-media\s*\{[^}]*min-height:\s*40px;[^}]*border:\s*1px solid var\(--line\)/);
  assert.match(responsive, /\.search-page \.search-filter-toggles\s*\{[^}]*grid-column:\s*1 \/ -1/);
  assert.match(responsive, /\.search-filter-form\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(responsive, /\.search-filter-form > input\[type="search"\],[\s\S]*?grid-column:\s*1 \/ -1/);
  assert.match(responsive, /\.link-field-row\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(responsive, /\.recovery-codes-list\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(responsive, /\.recovery-codes-actions > \*\s*\{[\s\S]*?width:\s*100%/);
});

test('app footer navigation links stay vertically grouped on phones', () => {
  const responsive = files.find((file) => file.name === 'responsive-layout.css').text;

  assert.match(responsive, /\.app-footer \.footer-col\s*\{\s*display:\s*grid/);
  assert.match(responsive, /\.app-footer \.footer-col a\s*\{[\s\S]*?display:\s*flex/);
  assert.match(responsive, /@media\s*\(max-width:\s*420px\)\s*\{[\s\S]*?\.app-footer \.footer-top\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

test('mobile headers span the viewport and keep public account actions in the menu', () => {
  const responsive = files.find((file) => file.name === 'responsive-layout.css').text;

  assert.match(responsive, /@media\s*\(max-width:\s*760px\)\s*\{[\s\S]*?\.site-nav\.container\s*\{[^}]*width:\s*100%;[^}]*margin-inline:\s*0;/);
  assert.match(responsive, /@media\s*\(max-width:\s*760px\)\s*\{[\s\S]*?\.site-nav\s*\{[^}]*position:\s*sticky;[^}]*border-bottom:\s*1px solid var\(--line\)/);
  assert.match(responsive, /@media\s*\(max-width:\s*560px\)\s*\{[\s\S]*?\.site-nav \.nav-actions \.button\s*\{\s*display:\s*none;/);
  assert.match(responsive, /\.site-nav \.nav-menu-toggle/);
});

test('shared view partials support safe-area mobile layouts and readable charts', () => {
  const responsive = files.find((file) => file.name === 'responsive-layout.css').text;
  const head = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'partials', 'head.ejs'), 'utf8');
  const chart = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'partials', 'growth-chart-svg.ejs'), 'utf8');

  assert.match(head, /name="viewport" content="[^"]*viewport-fit=cover/);
  assert.match(chart, /class="growth-chart-scroll" tabindex="0" role="region"/);
  assert.match(responsive, /\.growth-chart-scroll\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(responsive, /@media\s*\(max-width:\s*760px\)\s*\{[\s\S]*?\.growth-chart-scroll \.growth-chart\s*\{[^}]*width:\s*max\(100%,\s*440px\)/);
  assert.match(responsive, /@media\s*\(max-width:\s*760px\)\s*\{[\s\S]*?\.auth-shell\s*\{[^}]*env\(safe-area-inset-top\)[^}]*env\(safe-area-inset-bottom\)/);
  assert.match(responsive, /@media\s*\(max-width:\s*760px\)\s*\{[\s\S]*?\.reaction-picker\s*\{[^}]*flex-wrap:\s*wrap/);
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
