const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { icon } = require('../src/utils/icons');

const views = path.join(__dirname, '..', 'src', 'views');
const base = {
  title: 'Waves wallet',
  pagePath: '/wallet',
  noIndex: true,
  currentUser: { id: 'u1', name: 'Test User', role: 'user', wavesBalance: 125 },
  csrfToken: 'token',
  icon,
  wallet: { balance: 125, totalEarned: 200, totalSpent: 75 },
  transactions: [{
    type: 'earn',
    status: 'posted',
    description: 'Post reward',
    amount: 10,
    balanceAfter: 125,
    createdAt: new Date('2026-10-01T10:00:00Z')
  }]
};

test('wallet view shows current Waves balance and transaction ledger', async () => {
  const html = await ejs.renderFile(path.join(views, 'pages/wallet.ejs'), base);
  assert.match(html, /125 Waves/);
  assert.match(html, /Post reward/);
  assert.match(html, /\+10/);
  assert.match(html, /does not process real-money payments or payouts/);
});
