const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Community = require('../src/models/Community');
const User = require('../src/models/User');
const Post = require('../src/models/Post');
const Comment = require('../src/models/Comment');
const Quest = require('../src/models/Quest');
const communityController = require('../src/controllers/communityController');
const router = require('../src/routes/web');
const { csrfSynchronisedProtection } = require('../src/middleware/security');
const { removeUserFromCommunities } = require('../src/services/communityMembership');

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

test('account cleanup removes stale memberships and recalculates member counts atomically', async (t) => {
  const updateMany = t.mock.method(Community, 'updateMany', () => Promise.resolve({ modifiedCount: 1 }));
  const userId = '507f1f77bcf86cd799439011';
  await removeUserFromCommunities(userId);

  const [filter, pipeline] = updateMany.mock.calls[0].arguments;
  const id = new mongoose.Types.ObjectId(userId);
  assert.deepEqual(filter.$or, [
    { members: id },
    { moderators: id },
    { memberRoles: { $elemMatch: { user: id } } },
    { joinRequests: { $elemMatch: { user: id } } }
  ]);
  assert.equal(pipeline.length, 1);
  assert.deepEqual(pipeline[0].$set.membersCount, { $size: pipeline[0].$set.members });
  assert.deepEqual(pipeline[0].$set.members.$filter.cond, { $ne: ['$$entry', id] });
  assert.deepEqual(pipeline[0].$set.memberRoles.$filter.cond, { $ne: ['$$entry.user', id] });
});

test('opening a community repairs counts that include deleted accounts', async (t) => {
  const ownerId = new mongoose.Types.ObjectId();
  const activeId = new mongoose.Types.ObjectId();
  const deletedId = new mongoose.Types.ObjectId();
  const community = {
    _id: new mongoose.Types.ObjectId(),
    slug: 'makers',
    name: 'Makers',
    isPrivate: true,
    owner: { _id: ownerId, name: 'Owner' },
    members: [ownerId, activeId, deletedId],
    membersCount: 3,
    joinRequests: []
  };
  const findOne = t.mock.method(Community, 'findOne', () => ({
    populate: () => ({ lean: () => Promise.resolve(community) })
  }));
  const findUsers = t.mock.method(User, 'find', () => ({
    select: () => ({ lean: () => Promise.resolve([{ _id: ownerId }, { _id: activeId }]) })
  }));
  const updateCommunity = t.mock.method(Community, 'updateOne', () => Promise.resolve({ modifiedCount: 1 }));
  const res = {
    render(view, data) { this.view = view; this.data = data; },
    status() { return this; }
  };

  await communityController.detail({ params: { slug: 'makers' }, session: { user: { id: 'visitor' } } }, res);

  assert.equal(res.view, 'pages/community-request');
  assert.equal(community.membersCount, 2);
  assert.deepEqual(community.members.map(String), [String(ownerId), String(activeId)]);
  assert.deepEqual(findUsers.mock.calls[0].arguments[0]._id.$in, [ownerId, activeId, deletedId]);
  assert.deepEqual(updateCommunity.mock.calls[0].arguments[0], { _id: community._id, members: [ownerId, activeId, deletedId] });
  assert.deepEqual(updateCommunity.mock.calls[0].arguments[1], [{ $set: { members: [ownerId, activeId], membersCount: 2 } }]);
  assert.equal(findOne.mock.callCount(), 1);
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

test('private community join requests can be sent and cancelled asynchronously', async (t) => {
  const pending = [];
  const community = {
    _id: 'c2',
    slug: 'private-makers',
    isPrivate: true,
    membersCount: 0,
    members: makeMembers([]),
    joinRequests: pending,
    async save() {}
  };
  t.mock.method(Community, 'findById', () => Promise.resolve(community));
  const req = {
    params: { id: 'c2' },
    session: { user: { id: 'u1' } },
    get(name) { return name === 'X-Requested-With' ? 'XMLHttpRequest' : undefined; }
  };
  const joinRes = { json(data) { this.data = data; return this; } };
  await communityController.requestJoin(req, joinRes);
  assert.deepEqual(joinRes.data, { ok: true, joined: false, requested: true, membersCount: 0 });
  assert.deepEqual(pending, [{ user: 'u1' }]);

  const cancelRes = { json(data) { this.data = data; return this; } };
  await communityController.cancelJoinRequest(req, cancelRes);
  assert.deepEqual(cancelRes.data, { ok: true, joined: false, requested: false, membersCount: 0 });
  assert.deepEqual(community.joinRequests, []);
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

test('community detail paginates beyond the newest 30 published posts', async (t) => {
  const community = {
    _id: new mongoose.Types.ObjectId(),
    slug: 'makers',
    name: 'Makers',
    description: 'Build together',
    isPrivate: false,
    owner: { _id: new mongoose.Types.ObjectId(), name: 'Owner' },
    members: [],
    moderators: [],
    memberRoles: [],
    joinRequests: [],
    pinnedPosts: []
  };
  t.mock.method(Community, 'findOne', () => ({
    populate: () => ({ lean: () => Promise.resolve(community) })
  }));
  const postQuery = {
    sort(value) { this.sortValue = value; return this; },
    skip(value) { this.skipValue = value; return this; },
    limit(value) { this.limitValue = value; return this; },
    populate() { return this; },
    lean() { return Promise.resolve([]); }
  };
  const postFind = t.mock.method(Post, 'find', () => postQuery);
  t.mock.method(Post, 'countDocuments', () => Promise.resolve(65));
  t.mock.method(Post, 'aggregate', () => Promise.resolve([]));
  t.mock.method(Quest, 'find', () => ({
    sort() { return this; },
    populate() { return this; },
    lean: () => Promise.resolve([])
  }));
  const res = {
    locals: { appUrl: 'http://localhost:3000' },
    render(view, data) { this.view = view; this.data = data; },
    status() { return this; }
  };

  await communityController.detail({
    params: { slug: 'makers' },
    query: { page: '2' },
    session: { user: { id: 'visitor' } }
  }, res);

  assert.equal(res.view, 'pages/community-detail');
  assert.equal(res.data.postPage, 2);
  assert.equal(res.data.postTotalPages, 3);
  assert.equal(res.data.totalPostCount, 65);
  assert.equal(postFind.mock.callCount(), 1);
  assert.equal(postQuery.skipValue, 30);
  assert.equal(postQuery.limitValue, 30);
});

test('community member directory distinguishes roles and summarizes recent contribution', async (t) => {
  const community = {
    _id: 'community-1',
    slug: 'makers',
    name: 'Makers',
    description: 'Build together',
    isPrivate: false,
    owner: { _id: 'owner-1', name: 'Owner' },
    members: ['owner-1', 'mod-1', 'member-1'],
    moderators: [],
    memberRoles: [{ user: 'mod-1', role: 'moderator' }]
  };
  const members = [
    { _id: 'owner-1', name: 'Owner', followedTopics: ['design'], isVerified: true },
    { _id: 'mod-1', name: 'Moderator', followedTopics: [] },
    { _id: 'member-1', name: 'Member', followedTopics: [] }
  ];
  t.mock.method(Community, 'findOne', () => ({
    populate: () => ({ lean: () => Promise.resolve(community) })
  }));
  t.mock.method(User, 'find', () => ({
    select: () => ({ sort: () => ({ lean: () => Promise.resolve(members) }) })
  }));
  t.mock.method(Post, 'aggregate', () => Promise.resolve([
    { _id: 'mod-1', posts: 4, recentPosts: 2, lastPostAt: new Date() },
    { _id: 'member-1', posts: 1, recentPosts: 1, lastPostAt: new Date() }
  ]));
  t.mock.method(Comment, 'aggregate', () => Promise.resolve([
    { _id: 'mod-1', comments: 3, recentComments: 1, lastCommentAt: new Date() }
  ]));
  const res = {
    render(view, data) { this.view = view; this.data = data; },
    status() { return this; }
  };

  await communityController.memberDirectory({ params: { slug: 'makers' }, session: { user: { id: 'visitor' } } }, res);

  assert.equal(res.view, 'pages/community-members');
  assert.deepEqual(res.data.members.map(({ name }) => name), ['Moderator', 'Member', 'Owner']);
  assert.equal(res.data.members[0].communityRole, 'moderator');
  assert.equal(res.data.members[0].contributionScore, 15);
  assert.equal(res.data.members[0].recentPosts + res.data.members[0].recentComments, 3);
  assert.equal(res.data.members[2].communityRole, 'owner');
  assert.deepEqual(res.data.members[2].followedTopics, ['design']);
  assert.equal(res.data.memberStats.moderators, 1);
  assert.equal(res.data.memberStats.activeThisMonth, 2);
  assert.equal(res.data.memberStats.contributions, 8);
});
