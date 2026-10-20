const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { notificationPreferenceAllows } = require('../src/utils/notificationPreferences');
const Notification = require('../src/models/Notification');

test('post_reply is a valid notification type', () => {
  const doc = new Notification({ recipient: '507f1f77bcf86cd799439011', type: 'post_reply', message: 'x' });
  assert.equal(doc.validateSync(), undefined);
});
test('post_reply is delivered even when the member only wants mentions, but not when comments are off', () => {
  assert.equal(notificationPreferenceAllows({ mentionsOnly: true }, 'comments', 'post_reply'), true);
  assert.equal(notificationPreferenceAllows({ mentionsOnly: true }, 'comments', 'comment'), false);
  assert.equal(notificationPreferenceAllows({ comments: false }, 'comments', 'post_reply'), false);
});
test('reply-with-post notifies the original author with a link to the reply', () => {
  const src = fs.readFileSync('src/controllers/interactionController.js', 'utf8');
  assert.match(src, /'post_reply', 'replied to your post with a post\.', reply\._id, source\.community, req\.session\.user\.name, `\/posts\/\$\{reply\._id\}`/);
});
