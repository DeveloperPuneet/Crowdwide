const test = require('node:test');
const assert = require('node:assert/strict');
const Community = require('../src/models/Community');
const User = require('../src/models/User');
const communityController = require('../src/controllers/communityController');
const router = require('../src/routes/web');

test('private-community invite links are owner-managed and require authenticated confirmation', () => {
  const invite = router.stack.find((layer) => layer.route?.path === '/communities/:id/invite')?.route;
  const revoke = router.stack.find((layer) => layer.route?.path === '/communities/:id/invite/revoke')?.route;
  const preview = router.stack.find((layer) => layer.route?.path === '/communities/invite/:code')?.route;
  const join = router.stack.find((layer) => layer.route?.path === '/communities/invite/:code/join')?.route;
  assert.ok(invite && revoke && preview && join);
  assert.ok(invite.stack.some((layer) => layer.handle === communityController.ownerOnly));
  assert.ok(revoke.stack.some((layer) => layer.handle === communityController.ownerOnly));
  assert.ok(preview.stack.some((layer) => layer.handle.name === 'requireAuth'));
  assert.ok(join.stack.some((layer) => layer.handle.name === 'requireAuth'));
  assert.ok(join.stack.some((layer) => layer.handle.name.includes('csrf')));
  assert.equal(Community.schema.path('inviteCode').options.select, false);
  assert.equal(Community.schema.path('inviteCode').options.unique, true);
  assert.equal(Community.schema.path('inviteCode').options.sparse, true);
});

test('community owners can create and revoke an unguessable private invite link', async () => {
  let saves = 0;
  const community = {
    _id: 'c1',
    isPrivate: true,
    inviteCode: undefined,
    async save() { saves += 1; }
  };
  const req = { community, session: { flash: null } };
  const res = { redirect(path) { this.path = path; } };

  await communityController.createInvite(req, res);
  assert.match(community.inviteCode, /^[a-f0-9]{64}$/);
  assert.equal(saves, 1);
  assert.equal(res.path, '/communities/c1/manage');

  await communityController.revokeInvite(req, res);
  assert.equal(community.inviteCode, undefined);
  assert.equal(saves, 2);
  assert.equal(res.path, '/communities/c1/manage');
});

test('community invite generation refuses public communities', async () => {
  let saved = false;
  const req = { community: { _id: 'c1', isPrivate: false, async save() { saved = true; } }, session: { flash: null } };
  const res = { redirect(path) { this.path = path; } };

  await communityController.createInvite(req, res);
  assert.equal(saved, false);
  assert.equal(req.community.inviteCode, undefined);
  assert.equal(req.session.flash.type, 'error');
});

test('joining with a valid community invite adds membership immediately and clears a pending request', async (t) => {
  const memberIds = ['owner'];
  const community = {
    _id: 'c1',
    slug: 'private-sketches',
    name: 'Private Sketches',
    members: {
      some: (predicate) => memberIds.some(predicate),
      addToSet(id) { if (!memberIds.includes(String(id))) memberIds.push(String(id)); },
      get length() { return memberIds.length; }
    },
    memberRoles: [],
    joinRequests: [{ user: 'u1' }],
    async save() {}
  };
  const findOne = t.mock.method(Community, 'findOne', () => Promise.resolve(community));
  const updateUser = t.mock.method(User, 'findByIdAndUpdate', () => Promise.resolve({}));
  const req = { params: { code: 'valid-token' }, session: { user: { id: 'u1' }, flash: null } };
  const res = { redirect(path) { this.path = path; } };

  await communityController.joinByInvite(req, res);

  assert.deepEqual(findOne.mock.calls[0].arguments[0], { inviteCode: 'valid-token', isPrivate: true });
  assert.deepEqual(memberIds, ['owner', 'u1']);
  assert.deepEqual(community.memberRoles, [{ user: 'u1', role: 'member' }]);
  assert.deepEqual(community.joinRequests, []);
  assert.equal(community.membersCount, 2);
  assert.deepEqual(updateUser.mock.calls[0].arguments, ['u1', { $addToSet: { joinedCommunities: 'c1' } }]);
  assert.equal(res.path, '/communities/private-sketches');
});
