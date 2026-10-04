const test = require('node:test');
const assert = require('node:assert/strict');
const Community = require('../src/models/Community');
const User = require('../src/models/User');
const communityController = require('../src/controllers/communityController');
const router = require('../src/routes/web');
const { csrfSynchronisedProtection } = require('../src/middleware/security');

const findRoute = (path) => router.stack.find((layer) => layer.route?.path === path)?.route;

const makeMembers = (ids) => ({
  some: (predicate) => ids.some(predicate),
  pull(id) {
    const index = ids.findIndex((entry) => String(entry) === String(id));
    if (index >= 0) ids.splice(index, 1);
  },
  get length() { return ids.length; }
});

test('community membership actions are authenticated and CSRF protected', () => {
  for (const path of [
    '/communities/:id/join',
    '/communities/:id/leave',
    '/communities/:id/join-request/cancel'
  ]) {
    const route = findRoute(path);
    assert.ok(route, `${path} should be registered`);
    assert.ok(route.stack.some((layer) => layer.handle.name === 'requireAuth'));
    assert.ok(route.stack.some((layer) => layer.handle === csrfSynchronisedProtection));
  }
});

test('a member can leave and community membership records stay in sync', async (t) => {
  const memberIds = ['owner', 'u1'];
  const community = {
    _id: 'c1',
    slug: 'makers',
    name: 'Makers',
    owner: 'owner',
    members: makeMembers(memberIds),
    moderators: makeMembers(['u1']),
    memberRoles: [{ user: 'u1', role: 'moderator' }, { user: 'owner', role: 'member' }],
    joinRequests: [{ user: 'u1' }],
    async save() {}
  };
  const updateUser = t.mock.method(User, 'findByIdAndUpdate', () => Promise.resolve({}));
  const findCommunity = t.mock.method(Community, 'findById', () => Promise.resolve(community));
  const req = { params: { id: 'c1' }, session: { user: { id: 'u1' }, flash: null } };
  const res = { redirect(path) { this.path = path; } };

  await communityController.leaveCommunity(req, res);

  assert.deepEqual(findCommunity.mock.calls[0].arguments, ['c1']);
  assert.deepEqual(memberIds, ['owner']);
  assert.deepEqual(community.memberRoles, [{ user: 'owner', role: 'member' }]);
  assert.deepEqual(community.joinRequests, []);
  assert.equal(community.membersCount, 1);
  assert.deepEqual(updateUser.mock.calls[0].arguments, ['u1', { $pull: { joinedCommunities: 'c1' } }]);
  assert.equal(res.path, '/communities/makers');
  assert.equal(req.session.flash.type, 'success');
});

test('community owners cannot leave and a pending request can be cancelled', async (t) => {
  const ownerCommunity = {
    _id: 'c1', slug: 'makers', owner: 'u1',
    members: makeMembers(['u1']), moderators: makeMembers([]),
    memberRoles: [], joinRequests: [], async save() {}
  };
  let currentCommunity = ownerCommunity;
  const findCommunity = t.mock.method(Community, 'findById', () => Promise.resolve(currentCommunity));
  const updateUser = t.mock.method(User, 'findByIdAndUpdate', () => Promise.resolve({}));
  const ownerReq = { params: { id: 'c1' }, session: { user: { id: 'u1' }, flash: null } };
  const ownerRes = { redirect(path) { this.path = path; } };
  await communityController.leaveCommunity(ownerReq, ownerRes);
  assert.deepEqual(ownerCommunity.members.length, 1);
  assert.equal(ownerRes.path, '/communities/makers');
  assert.equal(updateUser.mock.callCount(), 0);

  const pending = {
    _id: 'c2', slug: 'private-makers',
    joinRequests: [{ user: 'u1' }, { user: 'u2' }],
    async save() {}
  };
  currentCommunity = pending;
  const cancelReq = { params: { id: 'c2' }, session: { user: { id: 'u1' }, flash: null } };
  const cancelRes = { redirect(path) { this.path = path; } };
  await communityController.cancelJoinRequest(cancelReq, cancelRes);
  assert.deepEqual(pending.joinRequests, [{ user: 'u2' }]);
  assert.equal(cancelRes.path, '/communities/private-makers');
  assert.equal(cancelReq.session.flash.type, 'success');
});

test('a pending private-community request renders the waiting page without loading private content', async (t) => {
  const community = {
    _id: 'c1', slug: 'private-makers', name: 'Private Makers',
    isPrivate: true, owner: { _id: 'owner', name: 'Owner' }, members: [],
    joinRequests: [{ user: 'u1' }]
  };
  t.mock.method(Community, 'findOne', () => ({
    populate: () => ({ lean: () => Promise.resolve(community) })
  }));
  const res = {
    render(view, data) { this.view = view; this.data = data; },
    status() { return this; }
  };

  await communityController.detail({ params: { slug: 'private-makers' }, session: { user: { id: 'u1' } } }, res);

  assert.equal(res.view, 'pages/community-request');
  assert.equal(res.data.requested, true);
  assert.equal(res.data.community, community);
});
