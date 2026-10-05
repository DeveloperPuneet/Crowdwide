const test = require('node:test');
const assert = require('node:assert/strict');
const { renderMentions } = require('../src/services/mentions');
const { notifyMentionedUsers } = require('../src/services/mentions');
const User = require('../src/models/User');
const Notification = require('../src/models/Notification');

test('renderMentions escapes content and links handles', () => {
  const rendered = renderMentions('<script>alert(1)</script> @Alice_1');
  assert.match(rendered, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(rendered, /href="\/search\?q=%40alice_1"/);
  assert.match(rendered, />@Alice_1<\/a>/);
});

test('group mentions only notify verified members of that group', async (t) => {
  const lookup = t.mock.method(User, 'findOne', () => ({
    select: () => ({ lean: async () => ({ _id: 'outsider-id', notificationPreferences: {} }) })
  }));
  const insert = t.mock.method(Notification, 'insertMany', async () => []);

  await notifyMentionedUsers('@outsider', 'sender-id', null, null, 'mentioned you in a group message.', {
    allowedUserIds: ['group-member-id'],
    url: '/groups/group-id'
  });

  assert.equal(lookup.mock.callCount(), 1);
  assert.equal(insert.mock.callCount(), 0);
});
