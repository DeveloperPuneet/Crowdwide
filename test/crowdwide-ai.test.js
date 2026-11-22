const test = require('node:test');
const assert = require('node:assert/strict');
const AiConversation = require('../src/models/AiConversation');
const AiMessage = require('../src/models/AiMessage');
const AiAction = require('../src/models/AiAction');
const AiMemory = require('../src/models/AiMemory');
const AiPreference = require('../src/models/AiPreference');
const aiController = require('../src/controllers/aiController');
const { deleteAiDataForUser } = require('../src/services/aiData');
const { enableLocalInferenceByDefault } = require('../src/services/aiPreferenceMigration');
const {
  buildFallbackResponse,
  extractSearchQuery,
  parseActionRequest,
  selectTool
} = require('../src/services/crowdwideAi');

function fakeRes() {
  const res = {};
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('on-device AI is enabled by default and existing preferences are migrated once', async (t) => {
  assert.equal(AiPreference.schema.path('localInference').defaultValue, true);
  assert.equal(AiPreference.schema.path('inferenceDevice').defaultValue, 'auto');
  const migration = t.mock.method(AiPreference, 'updateMany', async () => ({ modifiedCount: 1 }));

  await enableLocalInferenceByDefault();

  assert.deepEqual(migration.mock.calls[0].arguments, [
    { localInferenceDefaultMigrated: { $ne: true } },
    { $set: { localInference: true, localInferenceDefaultMigrated: true } }
  ]);
});

test('saving an AI opt-out marks it as an intentional preference', async (t) => {
  const userId = '507f1f77bcf86cd799439012';
  let update;
  t.mock.method(AiPreference, 'findOneAndUpdate', (_filter, changes) => {
    update = changes.$set;
    return { lean: async () => ({ localInference: false, inferenceDevice: 'cpu', theme: 'auto' }) };
  });
  const res = fakeRes();

  await aiController.updatePreferences({
    body: { localInference: false, inferenceDevice: 'cpu' },
    session: { user: { id: userId } }
  }, res);

  assert.deepEqual(update, { localInference: false, localInferenceDefaultMigrated: true, inferenceDevice: 'cpu' });
  assert.equal(res.body.preferences.localInference, false);
  assert.equal(res.body.preferences.inferenceDevice, 'cpu');
});

test('Crowdwide AI extracts search topics from conversational requests', () => {
  assert.equal(extractSearchQuery('Find posts about community building'), 'community building');
  assert.equal(extractSearchQuery('What are users saying about the new search?'), 'the new search');
  assert.equal(extractSearchQuery('Latest discussions about recommendations'), 'recommendations');
  assert.equal(extractSearchQuery('Who is @river?'), '@river');
  assert.equal(selectTool('What are users saying about the new search?'), 'comments');
  assert.equal(selectTool('What topics are trending on Crowdwide?'), 'trending');
  assert.equal(selectTool('What are the latest discussions on Crowdwide?'), 'recent');
  assert.equal(selectTool('Summarize this discussion 507f1f77bcf86cd799439011'), 'post_details');
});

test('account deletion removes all Crowdwide AI data for that account', async (t) => {
  const userId = '507f1f77bcf86cd799439012';
  const models = [AiAction, AiConversation, AiMemory, AiMessage, AiPreference];
  const calls = [];
  models.forEach((model) => {
    t.mock.method(model, 'deleteMany', async (filter) => {
      calls.push({ model, filter });
      return { deletedCount: 0 };
    });
  });

  await deleteAiDataForUser(userId);

  assert.equal(calls.length, models.length);
  assert.ok(calls.every((call) => call.filter.user === userId));
});

test('Crowdwide AI only treats explicit, fully specified post requests as actions', () => {
  assert.deepEqual(parseActionRequest('Publish this post: Hello Crowdwide'), {
    kind: 'create_post',
    content: 'Hello Crowdwide'
  });
  assert.deepEqual(parseActionRequest('Edit my post 507f1f77bcf86cd799439011 to: Updated text'), {
    kind: 'edit_post',
    postId: '507f1f77bcf86cd799439011',
    content: 'Updated text'
  });
  assert.deepEqual(parseActionRequest('Delete post 507f1f77bcf86cd799439011'), {
    kind: 'delete_post',
    postId: '507f1f77bcf86cd799439011'
  });
  assert.equal(parseActionRequest('I might want to delete my post later.'), null);
});

test('Crowdwide AI parses explicit social-action requests without deciding permissions', () => {
  assert.deepEqual(parseActionRequest("Create a post about today's progress on Crowdwide AI"), {
    kind: 'create_post',
    draftPrompt: "today's progress on Crowdwide AI"
  });
  assert.deepEqual(parseActionRequest('Comment on my latest post: Great update'), {
    kind: 'create_comment',
    postId: 'latest',
    content: 'Great update'
  });
  assert.deepEqual(parseActionRequest('Reply to the latest comment on my post'), {
    kind: 'reply_comment',
    commentId: 'latest_on_my_post',
    draftPrompt: 'Write a relevant, respectful reply to this comment.'
  });
  assert.deepEqual(parseActionRequest('Reply to the latest unread mention: Thanks for sharing'), {
    kind: 'reply_comment',
    commentId: 'latest_mention',
    content: 'Thanks for sharing'
  });
  assert.deepEqual(parseActionRequest('Message to @river: Hello there'), {
    kind: 'send_message',
    recipient: 'river',
    content: 'Hello there'
  });
  assert.deepEqual(parseActionRequest('Message in group 507f1f77bcf86cd799439011: Hello group'), {
    kind: 'send_message',
    groupId: '507f1f77bcf86cd799439011',
    content: 'Hello group'
  });
  assert.equal(selectTool('Show my unread mentions'), 'mentions');
  assert.equal(selectTool('Summarize my recent messages with @river'), 'chat_messages');
});

test('search fallback includes evidence links and clearly identifies its mode', () => {
  const answer = buildFallbackResponse({
    summary: 'I found one relevant public post visible to you.',
    sources: [{
      type: 'post',
      id: '507f1f77bcf86cd799439011',
      title: 'Post by Alex',
      url: '/posts/507f1f77bcf86cd799439011',
      excerpt: 'A useful discussion.'
    }]
  });
  assert.match(answer, /\[1\]\(\/posts\/507f1f77bcf86cd799439011\)/);
  assert.match(answer, /not generated by a language model/);
});

test('message history is not queried for a conversation owned by another user', async (t) => {
  const conversationId = '507f1f77bcf86cd799439011';
  const userId = '507f1f77bcf86cd799439012';
  const ownerCheck = t.mock.method(AiConversation, 'exists', async (filter) => {
    assert.deepEqual(filter, { _id: conversationId, user: userId });
    return null;
  });
  const messageQuery = t.mock.method(AiMessage, 'find', () => {
    throw new Error('Messages for another user must not be queried.');
  });
  const res = fakeRes();
  await aiController.listMessages({
    params: { id: conversationId },
    session: { user: { id: userId } }
  }, res);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'Conversation not found.' });
  assert.equal(ownerCheck.mock.callCount(), 1);
  assert.equal(messageQuery.mock.callCount(), 0);
});
