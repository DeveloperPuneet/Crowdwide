const test = require('node:test');
const assert = require('node:assert/strict');
const Community = require('../src/models/Community');
const Quest = require('../src/models/Quest');
const User = require('../src/models/User');
const communityController = require('../src/controllers/communityController');
const webRouter = require('../src/routes/web');

test('quest join and complete routes load their community before handling the action', () => {
  for (const suffix of ['join', 'complete']) {
    const routePath = `/communities/:id/quests/:questId/${suffix}`;
    const route = webRouter.stack.find((layer) => layer.route?.path === routePath)?.route;
    assert.ok(route, `missing quest ${suffix} route`);
    assert.ok(route.stack.some((layer) => layer.handle === communityController.loadCommunity), `quest ${suffix} route must load its community`);
  }
});

test('quest participation loads community context before joining', async (t) => {
  const community = { _id: 'c1', slug: 'sketch-club', members: ['u1'] };
  const participants = [];
  participants.addToSet = (userId) => { if (!participants.includes(userId)) participants.push(userId); };
  const quest = {
    _id: 'q1',
    status: 'open',
    participants,
    completedBy: [],
    async save() {}
  };
  t.mock.method(Community, 'findById', () => Promise.resolve(community));
  t.mock.method(Quest, 'findOne', (query) => {
    assert.deepEqual(query, { _id: 'q1', community: 'c1' });
    return Promise.resolve(quest);
  });
  const req = {
    params: { id: 'c1', questId: 'q1' },
    session: { user: { id: 'u1' }, flash: null },
    get: () => null
  };
  const res = { redirect(path) { this.path = path; } };
  let advanced = false;

  await communityController.loadCommunity(req, res, () => { advanced = true; });
  assert.equal(advanced, true);
  await communityController.toggleQuestParticipation(req, res);

  assert.deepEqual([...quest.participants], ['u1']);
  assert.equal(res.path, '/communities/sketch-club');
});

test('ending a quest and marking its reward sent return to the ID-based manage route', async (t) => {
  const quest = {
    _id: 'q1',
    community: 'c1',
    participants: ['u1'],
    completedBy: [],
    rewarded: false,
    async save() {}
  };
  t.mock.method(Quest, 'findOne', () => Promise.resolve(quest));
  t.mock.method(User, 'findById', () => ({ select: () => ({ lean: () => Promise.resolve({ name: 'Winner' }) }) }));
  const request = {
    params: { questId: 'q1' },
    body: { winnerId: 'u1' },
    community: { _id: 'c1', slug: 'sketch-club' },
    session: { user: { id: 'u1' }, flash: null }
  };
  const endResponse = { redirect(path) { this.path = path; } };
  await communityController.endQuest(request, endResponse);
  assert.equal(endResponse.path, '/communities/c1/manage');

  const rewardResponse = { redirect(path) { this.path = path; } };
  await communityController.rewardQuestWinner(request, rewardResponse);
  assert.equal(rewardResponse.path, '/communities/c1/manage');
});

test('quest creators can set a trimmed winner achievement tag', async (t) => {
  let createdQuest;
  t.mock.method(Quest, 'create', (values) => {
    createdQuest = values;
    return Promise.resolve({ title: values.title });
  });
  const req = {
    body: { title: 'Sketch sprint', achievementTag: '  Community Artist  ' },
    community: { _id: 'c1', slug: 'sketch-club' },
    session: { user: { id: 'u1' }, flash: null }
  };
  const res = { redirect(path) { this.path = path; } };

  await communityController.createQuest(req, res);

  assert.equal(createdQuest.achievementTag, 'Community Artist');
  assert.equal(res.path, '/communities/c1/manage');
});
