const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const Notification = require('../src/models/Notification');
const User = require('../src/models/User');
const interactionController = require('../src/controllers/interactionController');
const { icon } = require('../src/utils/icons');

const views = path.join(__dirname, '..', 'src', 'views');

test('opening notifications marks unread notifications as read', async (t) => {
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
  User.findById = () => ({ select: () => ({ lean: async () => ({ blockedUsers: [], mutedUsers: [] }) }) });
  User.updateOne = async (...args) => { calls.push(['user-update', ...args]); };
  Notification.updateMany = async (...args) => { calls.push(['notifications-update', ...args]); };
  Notification.find = (...args) => {
    calls.push(['find', ...args]);
    return {
      sort() { return this; },
      limit() { return this; },
      populate() { return this; },
      lean: async () => []
    };
  };
  Notification.countDocuments = async (...args) => {
    calls.push(['count', ...args]);
    return 0;
  };

  let rendered;
  await interactionController.notifications(
    { session: { user: { id: 'viewer-id' } } },
    { render: (template, data) => { rendered = { template, data }; } }
  );

  const markReadIndex = calls.findIndex(([name]) => name === 'notifications-update');
  const fetchIndex = calls.findIndex(([name]) => name === 'find');
  assert.ok(markReadIndex >= 0);
  assert.ok(fetchIndex > markReadIndex);
  assert.deepEqual(calls[markReadIndex][1], { recipient: 'viewer-id', readAt: null });
  assert.ok(calls[markReadIndex][2].readAt instanceof Date);
  assert.equal(rendered.template, 'pages/notifications');
  assert.equal(rendered.data.unread, 0);
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
