const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { icon } = require('../src/utils/icons');
const { isAdFree, addMonths, PLAN_DEFS } = require('../src/services/adFree');
const { normalizeUsername, validateUsername } = require('../src/services/username');

const views = path.join(__dirname, '..', 'src', 'views');
const base = {
  title: 'Waves wallet', pagePath: '/wallet', noIndex: true,
  currentUser: { id: 'u1', name: 'Test User', role: 'user', wavesBalance: 150 },
  csrfToken: 'token', icon,
  wallet: { balance: 150, totalEarned: 200, totalSpent: 50 }, transactions: [],
  username: 'tester',
  adFree: { enabled: true, active: false, until: null, plans: [
    { id: '1m', months: 1, label: '1 month', price: 100, savingsPercent: 0 },
    { id: '4m', months: 4, label: '4 months', price: 360, savingsPercent: 10 },
    { id: '12m', months: 12, label: '12 months', price: 1000, savingsPercent: 17 }
  ] }
};

test('isAdFree only when the expiry is in the future', () => {
  const now = new Date('2026-10-01T00:00:00Z');
  assert.equal(isAdFree({ adFreeUntil: new Date('2026-10-02T00:00:00Z') }, now), true);
  assert.equal(isAdFree({ adFreeUntil: new Date('2026-09-30T00:00:00Z') }, now), false);
  assert.equal(isAdFree({}, now), false);
  assert.equal(isAdFree(null, now), false);
});

test('addMonths uses calendar months and clamps month ends', () => {
  assert.equal(addMonths(new Date('2026-01-31T00:00:00Z'), 1).toISOString().slice(0, 10), '2026-02-28');
  assert.equal(addMonths(new Date('2026-10-09T00:00:00Z'), 12).toISOString().slice(0, 10), '2027-10-09');
  assert.deepEqual(PLAN_DEFS.map((p) => p.months), [1, 4, 12]);
});

test('usernames are normalised and validated', () => {
  assert.equal(normalizeUsername('  @Some_One '), 'some_one');
  assert.equal(validateUsername('ab').ok, false);
  assert.equal(validateUsername('bad name').ok, false);
  assert.equal(validateUsername('admin').ok, false);
  assert.deepEqual(validateUsername('@Good_Name1'), { ok: true, username: 'good_name1' });
});

test('wallet transfers by username and offers the three Ad-Free plans', async () => {
  const html = await ejs.renderFile(path.join(views, 'pages/wallet.ejs'), base);
  assert.match(html, /name="recipientUsername"/);
  assert.doesNotMatch(html, /recipientEmail/);
  assert.match(html, /@tester/);
  assert.match(html, /name="plan" value="1m"/);
  assert.match(html, /name="plan" value="4m"/);
  assert.match(html, /name="plan" value="12m"/);
  assert.match(html, /1,000/);
});

test('wallet disables plans the user cannot afford and shows active status', async () => {
  const html = await ejs.renderFile(path.join(views, 'pages/wallet.ejs'), {
    ...base, wallet: { ...base.wallet, balance: 5 },
    adFree: { ...base.adFree, active: true, until: new Date('2027-01-01T00:00:00Z') }
  });
  assert.match(html, /Not enough Waves/);
  assert.match(html, /Active until/);
});

test('bottom menu renders for signed-in users except on chat threads', async () => {
  const nav = path.join(views, 'partials/app-nav.ejs');
  const shown = await ejs.renderFile(nav, { icon, csrfToken: 't', currentUser: base.currentUser, active: 'home' });
  assert.match(shown, /class="bottom-nav"/);
  const hidden = await ejs.renderFile(nav, { icon, csrfToken: 't', currentUser: base.currentUser, active: 'messages', hideBottomNav: true });
  assert.doesNotMatch(hidden, /class="bottom-nav"/);
});
