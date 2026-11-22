const test = require('node:test');
const assert = require('node:assert/strict');
const AiConversation = require('../src/models/AiConversation');
const AiMessage = require('../src/models/AiMessage');
const AiAction = require('../src/models/AiAction');
const AiPreference = require('../src/models/AiPreference');
const AiMemory = require('../src/models/AiMemory');
const aiController = require('../src/controllers/aiController');
const { deleteAiDataForUser } = require('../src/services/aiData');
const {
  buildDirectResponse,
  buildFallbackResponse,
  extractSearchQuery,
  getCrowdwideKnowledge,
  isDirectReadTool,
  parseActionRequest,
  selectTool
} = require('../src/services/crowdwideAi');

function fakeRes() {
  const res = {};
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('AI preferences contain appearance settings only', () => {
  const AiPreference = require('../src/models/AiPreference');
  assert.equal(AiPreference.schema.path('theme').defaultValue, 'auto');
  assert.equal(AiPreference.schema.path('localInference'), undefined);
  assert.equal(AiPreference.schema.path('inferenceDevice'), undefined);
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

test('Crowdwide AI routes account reads deterministically and answers unread mentions from retrieved data', () => {
  assert.equal(selectTool('Show my unread mentions'), 'mentions');
  assert.equal(selectTool('Any new notifications?'), 'notifications');
  assert.equal(selectTool('Show my latest posts'), 'my_posts');
  assert.equal(selectTool('Show my comments'), 'my_comments');
  assert.equal(selectTool('Show my recent conversations'), 'chats');
  assert.equal(selectTool('Show my unread messages'), 'unread_messages');
  assert.equal(selectTool('Find discussions about AI'), 'comments');
  assert.equal(extractSearchQuery('Find discussions about AI'), 'AI');
  assert.equal(selectTool('Summarize this post'), 'post_details');
  assert.equal(selectTool('What is trending on Crowdwide?'), 'trending');
  assert.equal(isDirectReadTool(selectTool('Show my unread mentions')), true);
  assert.equal(buildDirectResponse('mentions', [], 'Show my unread mentions'), 'You have no unread mentions.');
});

test('Crowdwide knowledge is grounded in the curated project source and actions get drafts for announcements', () => {
  const knowledge = getCrowdwideKnowledge('What is Crowdwide?');
  assert.equal(knowledge.type, 'knowledge');
  assert.match(knowledge.excerpt, /social discovery platform/);
  assert.equal(selectTool('What features does Crowdwide offer?'), 'knowledge');
  assert.equal(selectTool("Summarize Crowdwide's latest developments"), 'knowledge');
  assert.deepEqual(parseActionRequest('Create a post introducing Crowdwide'), {
    kind: 'create_post',
    draftPrompt: 'Introduce Crowdwide'
  });
  assert.deepEqual(parseActionRequest('Write an announcement about Crowdwide AI'), {
    kind: 'create_post',
    draftPrompt: 'Write an announcement about Crowdwide AI'
  });
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
    unreadOnly: true,
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
  assert.deepEqual(parseActionRequest('Message to @river'), {
    kind: 'send_message',
    recipient: 'river',
    draftPrompt: 'Write a friendly, context-aware message for this conversation.'
  });
  assert.deepEqual(parseActionRequest('Reply to my latest conversation'), {
    kind: 'send_message',
    recipient: 'latest',
    draftPrompt: 'Write a friendly, context-aware reply to this conversation.'
  });
  assert.equal(selectTool('Show my unread mentions'), 'mentions');
  assert.equal(selectTool('Summarize my recent messages with @river'), 'chat_messages');
});

test('completed AI actions are retained for audit rather than expiring with pending drafts', () => {
  const expiryIndex = AiAction.schema.indexes().find(([keys]) => keys.expiresAt === 1);
  assert.ok(expiryIndex);
  assert.deepEqual(expiryIndex[1].partialFilterExpression, { status: 'pending' });
  assert.equal(expiryIndex[1].expireAfterSeconds, 0);
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
