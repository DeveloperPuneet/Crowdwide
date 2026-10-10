const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('moderation action model supports spam flags and auto-applied tracking', () => {
  const ModerationAction = require('../src/models/ModerationAction');
  const doc = new ModerationAction({ moderator: '507f1f77bcf86cd799439011', action: 'flag-spam', targetType: 'post', target: '507f1f77bcf86cd799439012', reason: 'spam', autoApplied: true });
  assert.equal(doc.validateSync(), undefined);
  assert.equal(new ModerationAction({}).autoApplied, false);
});

test('good, bad, edit, report and spam flags are low risk; warn, suspend, delete and community changes still queue', () => {
  const src = read('src/controllers/adminController.js');
  const m = src.match(/LOW_RISK_ACTIONS = new Set\(\[(.*?)\]\)/);
  const set = m[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  assert.deepEqual(set.sort(), ['edit-post', 'flag-spam', 'rate-bad-post', 'rate-good-post', 'report-post']);
  for (const high of ['warn-user', 'suspend-user', 'unsuspend-user', 'delete-post', 'edit-community']) assert.ok(!set.includes(high));
});

test('admin can revert auto-applied actions and the route is admin-only', () => {
  const routes = read('src/routes/web.js');
  assert.match(routes, /\/admin\/moderation\/:id\/revert', requireAuth, requireVerified, requireAdmin/);
  assert.equal(typeof require('../src/controllers/adminController').revertAutoAction, 'function');
});
