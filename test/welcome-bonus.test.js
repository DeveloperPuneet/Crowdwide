const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { icon } = require('../src/utils/icons');

const wallet = path.join(__dirname, '..', 'src', 'views', 'pages', 'wallet.ejs');
const base = {
  title: 'Waves wallet', pagePath: '/wallet', noIndex: true,
  currentUser: { id: 'u1', name: 'Test User', role: 'user', wavesBalance: 25 },
  csrfToken: 't', icon, wallet: { balance: 25, totalEarned: 25, totalSpent: 0 }, transactions: [],
  earnGuide: { dailyLimit: 20, welcomeBonus: 25, items: [
    { icon: 'file-text', title: 'Publish a post', detail: 'Share something.', range: '1–3' },
    { icon: 'users', title: 'Join a community', detail: 'Find spaces.', range: '1–2' }
  ] }
};

test('wallet explains how to earn Waves with live reward ranges', async () => {
  const html = await ejs.renderFile(wallet, base);
  assert.match(html, /How to earn Waves/);
  assert.match(html, /Publish a post/);
  assert.match(html, /\+1–3/);
  assert.match(html, /20 Waves a day/);
});

test('new members land on a welcome view that mentions the bonus', async () => {
  const html = await ejs.renderFile(wallet, { ...base, isWelcome: true });
  assert.match(html, /Your first Waves are here/);
  assert.match(html, /25 Waves<\/strong> to your wallet/);
});

test('welcome bonus is configurable and exposed in admin settings', () => {
  const SiteSetting = require('../src/models/SiteSetting');
  assert.equal(new SiteSetting({}).wavesWelcomeBonus, 25);
  const fs = require('node:fs');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src/views/pages/admin.ejs'), 'utf8'), /name="wavesWelcomeBonus"/);
});
