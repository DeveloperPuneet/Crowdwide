const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../src/models/User');
const settingsController = require('../src/controllers/settingsController');
const { notificationPreferenceAllows } = require('../src/utils/notificationPreferences');

test('comment notifications can be limited to mentions without muting other categories', () => {
  const preferences = { comments: true, mentionsOnly: true, likes: true };
  assert.equal(notificationPreferenceAllows(preferences, 'comments', 'comment'), false);
  assert.equal(notificationPreferenceAllows(preferences, 'comments', 'reply'), false);
  assert.equal(notificationPreferenceAllows(preferences, 'comments', 'mention'), true);
  assert.equal(notificationPreferenceAllows(preferences, 'likes', 'like'), true);
});

test('comments off suppresses mentions too, while legacy preferences keep all comments enabled', () => {
  assert.equal(notificationPreferenceAllows({ comments: false, mentionsOnly: true }, 'comments', 'mention'), false);
  assert.equal(notificationPreferenceAllows({ comments: true }, 'comments', 'reply'), true);
  assert.equal(notificationPreferenceAllows(undefined, 'comments', 'comment'), true);
});

test('saving notification settings stores the selected comments mode and other independent switches', async (t) => {
  let saved;
  t.mock.method(User, 'findByIdAndUpdate', async (...args) => { saved = args[1]; });
  const req = {
    session: { user: { id: 'u1' }, flash: null },
    body: {
      commentNotifications: 'mentions',
      notifyLikes: 'on',
      notifyFollows: 'on',
      notifyMessages: '',
      notifySecurity: 'on',
      emailNewsletter: '',
      emailUnreadSummary: 'on'
    }
  };
  const res = { redirect: (url) => { res.redirectedTo = url; } };

  await settingsController.setNotifications(req, res);

  assert.deepEqual(saved.notificationPreferences, {
    likes: true,
    comments: true,
    mentionsOnly: true,
    follows: true,
    messages: false,
    security: true,
    emailNewsletter: false,
    emailUnreadSummary: true
  });
  assert.equal(res.redirectedTo, '/settings/notifications');
});
