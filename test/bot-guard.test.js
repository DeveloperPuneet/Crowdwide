const test = require('node:test');
const assert = require('node:assert/strict');
const guard = require('../src/middleware/botGuard');
const BlockedIp = require('../src/models/BlockedIp');

const fakeReq = (ip, over = {}) => ({ ip, path: over.path || '/posts', originalUrl: over.path || '/posts', method: over.method || 'GET', session: over.session || {}, get: (h) => ({ 'user-agent': over.ua || 'Mozilla/5.0', accept: over.accept || 'text/html' })[h.toLowerCase()] || '', xhr: false });
const fakeRes = () => { const res = { code: 200, headers: {}, body: null, listeners: {} }; res.set = (k, v) => { res.headers[k] = v; return res; }; res.status = (c) => { res.code = c; res.statusCode = c; return res; }; res.type = () => res; res.send = (b) => { res.body = b; return res; }; res.json = (b) => { res.body = b; return res; }; res.on = (e, fn) => { res.listeners[e] = fn; }; res.statusCode = 200; return res; };
const run = (mw, req, res = fakeRes()) => { let passed = false; mw(req, res, () => { passed = true; }); return { passed, res }; };
const setup = (t) => {
  guard.reset();
  t.mock.method(BlockedIp, 'findOneAndUpdate', async () => ({}));
  t.mock.method(BlockedIp, 'deleteOne', async () => ({}));
  t.mock.method(BlockedIp, 'find', () => ({ select: () => ({ lean: async () => [] }) }));
};

test('ip normalisation and private ranges', () => {
  assert.equal(guard.normalizeIp('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(guard.normalizeIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64');
  assert.equal(guard.normalizeIp('2001:db8:1:2:1111::1'), '2001:db8:1:2::/64');
  for (const ip of ['127.0.0.1', '::1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '::ffff:10.0.0.4']) assert.equal(guard.isPrivate(ip), true, ip);
  assert.equal(guard.isPrivate('203.0.113.9'), false);
});

test('a request flood is blocked for 24 hours, then everything from that address gets a 403', (t) => {
  setup(t);
  let last;
  for (let i = 0; i <= guard.LIMITS.burst; i += 1) last = run(guard.track, fakeReq('203.0.113.9'));
  assert.equal(last.passed, false);
  assert.equal(last.res.code, 403);
  const entry = guard.isBlocked('203.0.113.9');
  assert.equal(entry.reason, 'burst');
  assert.ok(Math.abs(entry.until - Date.now() - 24 * 3600 * 1000) < 5000);
  const gated = run(guard.gate, fakeReq('203.0.113.9'));
  assert.equal(gated.passed, false);
  assert.equal(gated.res.code, 403);
  assert.ok(Number(gated.res.headers['Retry-After']) > 86000);
  assert.equal(run(guard.gate, fakeReq('203.0.113.10')).passed, true);
  assert.equal(BlockedIp.findOneAndUpdate.mock.callCount(), 1);
});

test('signed-in people and crawlers get more room than anonymous traffic', (t) => {
  setup(t);
  for (let i = 0; i < guard.LIMITS.burst + 20; i += 1) assert.equal(run(guard.track, fakeReq('203.0.113.20', { session: { user: { id: 'u1' } } })).passed, true);
  for (let i = 0; i < guard.LIMITS.burst + 20; i += 1) assert.equal(run(guard.track, fakeReq('203.0.113.21', { ua: 'Mozilla/5.0 (compatible; Googlebot/2.1)' })).passed, true);
  assert.equal(guard.isBlocked('203.0.113.20'), null);
});

test('scanner probes, scanner user agents and unsigned post floods are blocked', (t) => {
  setup(t);
  assert.equal(run(guard.track, fakeReq('198.51.100.1', { path: '/wp-login.php' })).passed, true);
  assert.equal(run(guard.track, fakeReq('198.51.100.1', { path: '/.env' })).passed, false);
  assert.equal(guard.isBlocked('198.51.100.1').reason, 'probing');
  assert.equal(run(guard.track, fakeReq('198.51.100.2', { ua: 'sqlmap/1.7' })).passed, false);
  assert.equal(guard.isBlocked('198.51.100.2').reason, 'scanner-ua');
  let last;
  for (let i = 0; i <= guard.LIMITS.posts; i += 1) last = run(guard.track, fakeReq('198.51.100.3', { method: 'POST', path: '/auth/register' }));
  assert.equal(last.passed, false);
  assert.equal(guard.isBlocked('198.51.100.3').reason, 'post-flood');
});

test('hammering after rate-limit replies and 404 floods are blocked', (t) => {
  setup(t);
  for (let i = 0; i < guard.LIMITS.limited; i += 1) { const { res } = run(guard.track, fakeReq('198.51.100.4')); res.statusCode = 429; res.listeners.finish(); }
  assert.equal(guard.isBlocked('198.51.100.4').reason, 'rate-abuse');
  for (let i = 0; i < 40; i += 1) { const { res } = run(guard.track, fakeReq('198.51.100.5', { path: '/nope' + i })); res.statusCode = 404; res.listeners.finish(); }
  assert.equal(guard.isBlocked('198.51.100.5').reason, '404-flood');
});

test('private addresses, /health, the allowlist and BOT_GUARD=off are never blocked; JSON callers get JSON', (t) => {
  setup(t);
  for (let i = 0; i < 400; i += 1) assert.equal(run(guard.track, fakeReq('10.0.0.5')).passed, true);
  for (let i = 0; i < 400; i += 1) assert.equal(run(guard.track, fakeReq('203.0.113.50', { path: '/health' })).passed, true);
  process.env.BOT_GUARD_ALLOWLIST = '203.0.113.60';
  for (let i = 0; i < 400; i += 1) assert.equal(run(guard.track, fakeReq('203.0.113.60')).passed, true);
  delete process.env.BOT_GUARD_ALLOWLIST;
  process.env.BOT_GUARD = 'off';
  for (let i = 0; i < 400; i += 1) assert.equal(run(guard.track, fakeReq('203.0.113.70')).passed, true);
  delete process.env.BOT_GUARD;
  guard.block('203.0.113.80', 'burst', fakeReq('203.0.113.80'));
  const json = run(guard.gate, fakeReq('203.0.113.80', { accept: 'application/json' }));
  assert.match(String(json.res.body.error), /24 hours/);
});

test('an admin can unblock an address', async (t) => {
  setup(t);
  guard.block('203.0.113.90', 'burst', fakeReq('203.0.113.90'));
  assert.ok(guard.isBlocked('203.0.113.90'));
  await guard.unblock('203.0.113.90');
  assert.equal(guard.isBlocked('203.0.113.90'), null);
  assert.equal(run(guard.gate, fakeReq('203.0.113.90')).passed, true);
  assert.equal(BlockedIp.deleteOne.mock.callCount(), 1);
});
