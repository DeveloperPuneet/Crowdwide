const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const ejs = require('ejs');
const Notification = require('../src/models/Notification');
const User = require('../src/models/User');
const controller = require('../src/controllers/interactionController');
const { icon } = require('../src/utils/icons');

const oid = (n) => String(n).padStart(24, 'a');
const actor = (n, name) => ({ _id: oid(n), name });
const row = (n, extra = {}) => ({ _id: oid(100 + n), type: 'like', post: oid(9), actor: actor(n, `User${n}`), message: 'liked your post', createdAt: new Date('2026-10-30T05:00:00Z'), readAt: null, ...extra });

test('likes on one post from several people collapse into one row that remembers every id', () => {
  const groups = controller.groupNotifications([row(1), row(2), row(3, { readAt: new Date() }), row(4, { post: oid(8) })]);
  assert.equal(groups.length, 2);
  const [first, second] = groups;
  assert.equal(first.count, 3);
  assert.deepEqual(first.ids, [oid(101), oid(102), oid(103)]);
  assert.deepEqual(first.unreadIds, [oid(101), oid(102)]);
  assert.equal(first.readAt, null, 'a row with any unread notification stays unread');
  assert.equal(first.actors.length, 3);
  assert.equal(second.count, 1);
});

test('only identical comment events from the same person collapse; different people stay separate', () => {
  const comment = (n, actorN) => row(n, { type: 'comment', actor: actor(actorN, `U${actorN}`), message: 'commented' });
  const groups = controller.groupNotifications([comment(1, 1), comment(2, 1), comment(3, 2)]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].count, 2);
});

test('a fully read group is read', () => {
  const groups = controller.groupNotifications([row(1, { readAt: new Date() }), row(2, { readAt: new Date() })]);
  assert.ok(groups[0].readAt);
  assert.deepEqual(groups[0].unreadIds, []);
});

test('day labels follow the reader\'s time zone, and ages read naturally', () => {
  const now = new Date('2026-10-30T20:00:00Z'); // 01:30 on the 31st in India
  assert.equal(controller.notificationDayLabel(new Date('2026-10-30T19:00:00Z'), 'Asia/Kolkata', now), 'Today');
  assert.equal(controller.notificationDayLabel(new Date('2026-10-30T19:00:00Z'), 'UTC', now), 'Today');
  assert.equal(controller.notificationDayLabel(new Date('2026-10-30T10:00:00Z'), 'Asia/Kolkata', now), 'Yesterday');
  assert.equal(controller.notificationDayLabel(new Date('2026-10-26T10:00:00Z'), 'UTC', now), 'Earlier this week');
  assert.equal(controller.notificationDayLabel(new Date('2026-09-01T10:00:00Z'), 'UTC', now), 'Earlier');
  assert.equal(controller.notificationDayLabel(new Date('2026-10-30T10:00:00Z'), 'Not/AZone', now), 'Today');
  assert.equal(controller.notificationAgo(new Date(now - 20 * 1000), now), 'Just now');
  assert.equal(controller.notificationAgo(new Date(now - 5 * 60000), now), '5m ago');
  assert.equal(controller.notificationAgo(new Date(now - 3 * 3600000), now), '3h ago');
  assert.equal(controller.notificationAgo(new Date(now - 2 * 86400000), now), '2d ago');
});

test('marking only touches the signed-in person\'s own notifications and replies with the new unread total', async (t) => {
  let update;
  t.mock.method(Notification, 'updateMany', async (filter, change) => { update = { filter, change }; return {}; });
  t.mock.method(Notification, 'countDocuments', async () => 2);
  t.mock.method(User, 'updateOne', async () => ({}));
  const res = { json(body) { this.body = body; return this; }, status(code) { this.code = code; return this; } };
  await controller.markNotifications({ session: { user: { id: 'me' } }, body: { ids: [oid(1), 'not-an-id', oid(2)], read: true } }, res);
  assert.equal(update.filter.recipient, 'me');
  assert.deepEqual(update.filter._id.$in, [oid(1), oid(2)]);
  assert.ok(update.change.readAt instanceof Date);
  assert.deepEqual(res.body, { ok: true, unread: 2 });

  await controller.markNotifications({ session: { user: { id: 'me' } }, body: { ids: oid(3), read: false } }, res);
  assert.deepEqual(update.change, { $unset: { readAt: 1 } });

  const bad = { json(body) { this.body = body; return this; }, status(code) { this.code = code; return this; } };
  await controller.markNotifications({ session: { user: { id: 'me' } }, body: { ids: ['nope'] } }, bad);
  assert.equal(bad.code, 400);
});

test('mark all read answers JSON for the page and still redirects for a plain form post', async (t) => {
  t.mock.method(Notification, 'updateMany', async () => ({}));
  t.mock.method(User, 'updateOne', async () => ({}));
  const make = (headers) => ({ req: { session: { user: { id: 'me' } }, xhr: false, get: (name) => headers[name.toLowerCase()] }, res: { json(b) { this.body = b; }, redirect(u) { this.to = u; } } });
  const ajax = make({ accept: 'application/json' });
  await controller.readNotifications(ajax.req, ajax.res);
  assert.deepEqual(ajax.res.body, { ok: true, unread: 0 });
  const plain = make({});
  await controller.readNotifications(plain.req, plain.res);
  assert.equal(plain.res.to, '/notifications');
});

test('notifications page renders grouped rows, the read toggle and day headings', async () => {
  const views = path.join(__dirname, '..', 'src', 'views');
  const groups = controller.groupNotifications([row(1), row(2), row(3)]).map((g) => ({ ...g, dayLabel: 'Today', ago: '5m ago' }));
  const html = await ejs.renderFile(path.join(views, 'pages', 'notifications.ejs'), {
    icon, csrfToken: 't', flash: null, currentUser: { id: 'me', name: 'Me', role: 'user' }, title: 'n', pagePath: '/notifications', noIndex: true,
    notifications: groups, unread: 3, unreadOnly: false, hasMore: true, nextBefore: '2026-10-30T05:00:00.000Z'
  });
  assert.match(html, /<h2 class="notification-day" data-day-label="Today">Today<\/h2>/);
  assert.match(html, /User1, User2 and 1 other/);
  assert.match(html, /data-ids="a{21}101,a{21}102,a{21}103"/);
  assert.match(html, /data-notification-toggle aria-pressed="false" aria-label="Mark as read"/);
  assert.match(html, /data-notification-more data-before="2026-10-30T05:00:00.000Z"/);
  assert.match(html, /src="\/js\/notifications\.js"/);
});

test('page script uses the optimistic runner and never reloads', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'notifications.js'), 'utf8');
  assert.match(js, /cwOptimistic\.run\(list/);
  assert.match(js, /preventDefault\(\)/);
  assert.doesNotMatch(js, /location\.(reload|href)|\.submit\(\)/);
});
