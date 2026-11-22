const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { icon } = require('../src/utils/icons');
const User = require('../src/models/User');
const WavesLedgerEntry = require('../src/models/WavesLedgerEntry');
const { isAdFree, addMonths, PLAN_DEFS, cancelAdFree, calculateAdFreeRefund } = require('../src/services/adFree');
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

test('Ad-Free cancellation refunds only the unused Waves across stacked plans', () => {
  const entries = [
    { type: 'spend', referenceType: 'ad-free', description: 'Ad-Free plan (1 month)', amount: -100, createdAt: new Date('2026-01-01T00:00:00Z') },
    { type: 'spend', referenceType: 'ad-free', description: 'Ad-Free plan (4 months)', amount: -360, createdAt: new Date('2026-01-10T00:00:00Z') }
  ];
  const now = new Date('2026-01-16T00:00:00Z');
  const activeUntil = addMonths(addMonths(entries[0].createdAt, 1), 4);
  const expected = 100 * (addMonths(entries[0].createdAt, 1) - now) / (addMonths(entries[0].createdAt, 1) - entries[0].createdAt) + 360;

  assert.equal(calculateAdFreeRefund(entries, now, activeUntil), Number(expected.toFixed(6)));
});

test('Ad-Free refund calculation resets after a previous cancellation', () => {
  const entries = [
    { type: 'spend', referenceType: 'ad-free', description: 'Ad-Free plan (4 months)', amount: -360, createdAt: new Date('2026-01-01T00:00:00Z') },
    { type: 'refund', referenceType: 'ad-free-cancellation', amount: 300, createdAt: new Date('2026-02-01T00:00:00Z') },
    { type: 'spend', referenceType: 'ad-free', description: 'Ad-Free plan (1 month)', amount: -100, createdAt: new Date('2026-02-01T00:00:01Z') }
  ];

  assert.equal(calculateAdFreeRefund(entries, new Date('2026-02-15T00:00:01Z'), new Date('2026-03-01T00:00:01Z')), 50);
});

test('cancelAdFree atomically ends access and posts the unused-Waves refund', async (t) => {
  const now = new Date('2026-01-16T00:00:00Z');
  const activeUntil = new Date('2026-02-01T00:00:00Z');
  const purchase = { referenceType: 'ad-free', description: 'Ad-Free plan (1 month)', amount: -100, createdAt: new Date('2026-01-01T00:00:00Z') };
  const ledger = { async save() { return this; } };
  let update;
  t.mock.method(User, 'findById', () => ({ select() { return this; }, lean: async () => ({ adFreeUntil: activeUntil }) }));
  t.mock.method(WavesLedgerEntry, 'find', () => ({
    sort() { return this; }, select() { return this; }, lean: async () => [purchase]
  }));
  const createLedger = t.mock.method(WavesLedgerEntry, 'create', async (entry) => Object.assign(ledger, entry));
  t.mock.method(User, 'findOneAndUpdate', (filter, changes) => {
    update = { filter, changes };
    return { select: async () => ({ wavesBalance: 75 }) };
  });

  const result = await cancelAdFree({ userId: 'u1', now });

  assert.equal(result.refund, Number((100 * 16 / 31).toFixed(6)));
  assert.equal(result.balance, 75);
  assert.equal(update.filter.adFreeUntil, activeUntil);
  assert.equal(update.changes.$set.adFreeUntil, null);
  assert.equal(update.changes.$inc.wavesBalance, result.refund);
  assert.equal(update.changes.$inc.wavesTotalSpent, -result.refund);
  assert.equal(createLedger.mock.callCount(), 1);
  assert.equal(ledger.type, 'refund');
  assert.equal(ledger.status, 'posted');
  assert.equal(ledger.balanceAfter, 75);
});

test('a concurrent Ad-Free cancellation cannot post a second refund', async (t) => {
  const activeUntil = new Date('2026-02-01T00:00:00Z');
  const ledger = { async save() { return this; } };
  t.mock.method(User, 'findById', () => ({ select() { return this; }, lean: async () => ({ adFreeUntil: activeUntil }) }));
  t.mock.method(WavesLedgerEntry, 'find', () => ({
    sort() { return this; }, select() { return this; }, lean: async () => []
  }));
  t.mock.method(WavesLedgerEntry, 'create', async (entry) => Object.assign(ledger, entry));
  t.mock.method(User, 'findOneAndUpdate', () => ({ select: async () => null }));

  await assert.rejects(() => cancelAdFree({ userId: 'u1', now: new Date('2026-01-16T00:00:00Z') }), /plan changed before cancellation/i);
  assert.equal(ledger.status, 'reversed');
  assert.match(ledger.reason, /cancellation was not applied/);
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
  assert.match(html, /wallet\/ad-free\/cancel/);
  assert.match(html, /unused time will be refunded/);
});

test('bottom menu renders for signed-in users except on chat threads', async () => {
  const nav = path.join(views, 'partials/app-nav.ejs');
  const shown = await ejs.renderFile(nav, { icon, csrfToken: 't', currentUser: base.currentUser, active: 'home' });
  assert.match(shown, /class="bottom-nav"/);
  const hidden = await ejs.renderFile(nav, { icon, csrfToken: 't', currentUser: base.currentUser, active: 'messages', hideBottomNav: true });
  assert.doesNotMatch(hidden, /class="bottom-nav"/);
});
