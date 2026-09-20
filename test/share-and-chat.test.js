const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTargets } = require('../src/controllers/shareController');
const chat = require('../src/services/chat');
const Message = require('../src/models/Message');
const Comment = require('../src/models/Comment');
const GroupMessage = require('../src/models/GroupMessage');

const id = (n) => String(n).repeat(24).slice(0, 24);

test('parseTargets keeps valid u:/g: ids, dedupes and caps at 10', () => {
  assert.deepEqual(parseTargets([`u:${id(1)}`, `g:${id(2)}`, `u:${id(1)}`, 'x:123', 'u:short']), [`u:${id(1)}`, `g:${id(2)}`]);
  assert.deepEqual(parseTargets(`u:${id(1)}, g:${id(2)}`), [`u:${id(1)}`, `g:${id(2)}`]);
  const many = Array.from({ length: 15 }, (_, i) => `u:${String(i).padStart(24, '0')}`);
  assert.equal(parseTargets(many).length, 10);
  assert.deepEqual(parseTargets(undefined), []);
});

test('chat helpers: previews, ids and excerpts', () => {
  assert.equal(chat.previewText({ body: 'hello' }), 'hello');
  assert.equal(chat.previewText({ body: '', gif: { url: 'https://media.giphy.com/a.gif' } }), 'Sent a GIF');
  assert.equal(chat.previewText({ body: '', sharedPost: 'p' }), 'Shared a post');
  assert.equal(chat.isObjectId(id('a')), true);
  assert.equal(chat.isObjectId('nope'), false);
  assert.equal(chat.excerpt('a'.repeat(300), 20).length, 20);
  const preview = chat.buildPostPreview({ _id: 'p1', type: 'article', body: 'Body text', author: { name: 'Ravi' }, media: [{ kind: 'image', url: '/m/1' }] });
  assert.deepEqual([preview.label, preview.author, preview.image], ['Article', 'Ravi', '/m/1']);
});

test('messages and comments need text, a GIF or a shared post', async () => {
  const gif = { url: 'https://media.giphy.com/a.gif' };
  // validate() (not validateSync) runs the pre-validate hook, like create() does.
  const failure = async (doc) => (await doc.validate().then(() => null, (error) => error))?.errors?.body;
  assert.ok(await failure(new Message({ sender: id(1), recipient: id(2), body: '' })));
  assert.equal(await failure(new Message({ sender: id(1), recipient: id(2), gif })), undefined);
  assert.equal(await failure(new Message({ sender: id(1), recipient: id(2), sharedPost: id(3) })), undefined);
  assert.ok(await failure(new GroupMessage({ group: id(1), sender: id(2) })));
  assert.equal(await failure(new GroupMessage({ group: id(1), sender: id(2), gif })), undefined);
  assert.ok(await failure(new Comment({ post: id(1), author: id(2) })));
  assert.equal(await failure(new Comment({ post: id(1), author: id(2), gif })), undefined);
});
