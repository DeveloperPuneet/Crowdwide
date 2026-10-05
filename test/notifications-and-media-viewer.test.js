const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const Notification = require('../src/models/Notification');
const User = require('../src/models/User');
const interactionController = require('../src/controllers/interactionController');
const { icon } = require('../src/utils/icons');

const views = path.join(__dirname, '..', 'src', 'views');

test('opening notifications keeps unread notifications unread until explicitly marked read', async (t) => {
  const originals = {
    findById: User.findById,
    updateOne: User.updateOne,
    updateMany: Notification.updateMany,
    find: Notification.find,
    countDocuments: Notification.countDocuments
  };
  t.after(() => {
    Object.assign(User, { findById: originals.findById, updateOne: originals.updateOne });
    Object.assign(Notification, {
      updateMany: originals.updateMany,
      find: originals.find,
      countDocuments: originals.countDocuments
    });
  });

  const calls = [];
  const notificationRows = [
    { _id: 'dm-one', actor: { _id: 'sender-id', name: 'Sender' }, type: 'message', message: 'sent you a message.', url: '/messages/sender-id', readAt: null, createdAt: new Date() },
    { _id: 'group-one', actor: { _id: 'sender-id', name: 'Sender' }, type: 'message', message: 'sent a message in a group.', url: '/groups/group-id', readAt: null, createdAt: new Date() }
  ];
  User.findById = () => ({ select: () => ({ lean: async () => ({ blockedUsers: [], mutedUsers: [] }) }) });
  User.updateOne = async (...args) => { calls.push(['user-update', ...args]); };
  Notification.updateMany = async (...args) => { calls.push(['notifications-update', ...args]); };
  Notification.find = (...args) => {
    calls.push(['find', ...args]);
    return {
      sort() { return this; },
      limit() { return this; },
      populate() { return this; },
      lean: async () => notificationRows
    };
  };
  Notification.countDocuments = async (...args) => {
    calls.push(['count', ...args]);
    return 3;
  };

  let rendered;
  await interactionController.notifications(
    { session: { user: { id: 'viewer-id' } } },
    { render: (template, data) => { rendered = { template, data }; } }
  );

  const fetchIndex = calls.findIndex(([name]) => name === 'find');
  assert.equal(calls.findIndex(([name]) => name === 'notifications-update'), -1);
  assert.ok(fetchIndex >= 0);
  assert.equal(rendered.template, 'pages/notifications');
  assert.equal(rendered.data.unread, 3);
  assert.equal(rendered.data.notifications.length, 2, 'unread items from different chats must remain separate');
  assert.deepEqual(rendered.data.notifications.map((notification) => notification.url), ['/messages/sender-id', '/groups/group-id']);
  assert.ok(calls.some(([name, query]) => name === 'count' && query.readAt === null));
});

test('post media renders clickable full-size images and expandable videos', async () => {
  const html = await ejs.renderFile(path.join(views, 'partials/post-media.ejs'), {
    post: {
      media: [
        { kind: 'image', url: '/media/original.jpg', thumbnailUrl: '/media/preview.jpg', alt: 'A landscape' },
        { kind: 'video', url: '/media/clip.mp4' }
      ]
    },
    icon
  });

  assert.match(html, /src="\/media\/preview\.jpg" data-media-viewer data-media-src="\/media\/original\.jpg"/);
  assert.match(html, /aria-label="View video larger"/);
  assert.match(html, /data-media-viewer-trigger/);
  assert.match(html, /data-media-src="\/media\/clip\.mp4"/);
});
