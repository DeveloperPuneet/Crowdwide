const test = require('node:test');
const assert = require('node:assert/strict');

const Post = require('../src/models/Post');
const SiteSetting = require('../src/models/SiteSetting');
const Community = require('../src/models/Community');
const User = require('../src/models/User');
const Report = require('../src/models/Report');
const AuditLog = require('../src/models/AuditLog');
const communityController = require('../src/controllers/communityController');
const adminController = require('../src/controllers/adminController');

function mockAdditionalEligibility(t, overrides = {}) {
  const community = {
    _id: 'community-1',
    owner: 'owner-1',
    createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
    isPrivate: false
  };
  const owner = {
    isVerified: true,
    warnings: [],
    ...overrides.owner
  };
  t.mock.method(Community, 'findById', () => ({
    select: async () => ({ ...community, ...overrides.community })
  }));
  t.mock.method(User, 'findById', () => ({
    select: () => ({ lean: async () => owner })
  }));
  t.mock.method(Report, 'countDocuments', async () => overrides.confirmedViolations || 0);
}

test('monetization eligibility uses configured published-post totals', async (t) => {
  t.mock.method(SiteSetting, 'getSingleton', async () => ({
    monetizationMinimumPosts: 20,
    monetizationMinimumLikes: 30,
    monetizationMinimumComments: 10
  }));
  t.mock.method(Post, 'aggregate', async () => [{ posts: 20, likes: 30, comments: 9, lastPostAt: new Date() }]);
  t.mock.method(Post, 'distinct', async () => []);
  mockAdditionalEligibility(t);

  const result = await communityController.getMonetizationEligibility('community-1');

  assert.equal(result.requirements.posts.met, true);
  assert.equal(result.requirements.likes.met, true);
  assert.equal(result.requirements.comments.met, false);
  assert.equal(result.eligible, false);
});

test('monetization application is rejected unless server-side requirements are met', async (t) => {
  t.mock.method(SiteSetting, 'getSingleton', async () => ({
    monetizationMinimumPosts: 20,
    monetizationMinimumLikes: 30,
    monetizationMinimumComments: 10
  }));
  t.mock.method(Post, 'aggregate', async () => [{ posts: 19, likes: 30, comments: 10, lastPostAt: new Date() }]);
  t.mock.method(Post, 'distinct', async () => []);
  mockAdditionalEligibility(t);

  let saved = false;
  const community = {
    _id: 'community-1',
    monetizationStatus: 'none',
    monetizationApplication: {},
    monetizationSettings: {},
    monetizationHistory: [],
    async save() {
      saved = true;
    }
  };
  const req = {
    community,
    body: {},
    session: { user: { id: 'owner-1', name: 'Owner' }, flash: null }
  };
  const res = { redirect(path) { this.path = path; } };

  await communityController.submitMonetizationApplication(req, res);

  assert.equal(saved, false);
  assert.equal(community.monetizationStatus, 'none');
  assert.match(req.session.flash.message, /does not yet meet/i);
  assert.equal(res.path, '/communities/community-1/manage#monetization');
});

test('eligible community can apply without submitting advertising or revenue settings', async (t) => {
  t.mock.method(SiteSetting, 'getSingleton', async () => ({
    monetizationMinimumPosts: 20,
    monetizationMinimumLikes: 30,
    monetizationMinimumComments: 10
  }));
  t.mock.method(Post, 'aggregate', async () => [{ posts: 20, likes: 30, comments: 10, lastPostAt: new Date() }]);
  t.mock.method(Post, 'distinct', async () => []);
  mockAdditionalEligibility(t);

  const community = {
    _id: 'community-2',
    monetizationStatus: 'none',
    monetizationApplication: {},
    monetizationSettings: {},
    monetizationHistory: [],
    async save() {}
  };
  const req = {
    community,
    body: {},
    session: { user: { id: 'owner-2', name: 'Community Owner' }, flash: null }
  };
  const res = { redirect(path) { this.path = path; } };

  await communityController.submitMonetizationApplication(req, res);

  assert.equal(community.monetizationStatus, 'pending');
  assert.equal(community.monetizationApplication.applicantName, 'Community Owner');
  assert.equal(community.monetizationApplication.businessName, undefined);
  assert.equal(community.monetizationSettings.adPlacement, undefined);
  assert.equal(community.monetizationSettings.revenueSharePercent, undefined);
  assert.equal(res.path, '/communities/community-2/manage#monetization');
});

test('monetization eligibility blocks communities that are too new or owners with recent violations', async (t) => {
  t.mock.method(SiteSetting, 'getSingleton', async () => ({
    monetizationMinimumPosts: 1,
    monetizationMinimumLikes: 0,
    monetizationMinimumComments: 0,
    monetizationMinimumCommunityAgeDays: 30,
    monetizationRecentActivityDays: 30
  }));
  t.mock.method(Post, 'aggregate', async () => [{ posts: 1, likes: 0, comments: 0, lastPostAt: new Date() }]);
  t.mock.method(Post, 'distinct', async () => []);
  mockAdditionalEligibility(t, {
    community: { createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
    owner: { isVerified: false },
    confirmedViolations: 1
  });

  const result = await communityController.getMonetizationEligibility('community-1');

  assert.equal(result.requirements.age.met, false);
  assert.equal(result.requirements.ownerStanding.met, false);
  assert.equal(result.requirements.policyHistory.met, false);
  assert.equal(result.eligible, false);
});

test('community monetization appeal requires a meaningful message and records review history', async (t) => {
  const community = {
    _id: 'community-appeal',
    monetizationStatus: 'rejected',
    monetizationApplication: { rejectionReason: 'Policy review needed.' },
    monetizationHistory: [],
    async save() {}
  };
  const req = {
    community,
    body: { message: 'We corrected the policy issue and request another review.' },
    session: { user: { id: 'owner-appeal' }, flash: null }
  };
  const res = { redirect(path) { this.path = path; } };

  await communityController.submitMonetizationAppeal(req, res);

  assert.equal(community.monetizationApplication.appealStatus, 'pending');
  assert.equal(community.monetizationHistory.at(-1).action, 'appeal-submitted');
  assert.equal(res.path, '/communities/community-appeal/manage#monetization');
});

test('admin cannot approve monetization before moderator clearance', async (t) => {
  const community = {
    _id: 'community-review',
    monetizationStatus: 'pending',
    monetizationModeratorReview: { status: 'pending' }
  };
  t.mock.method(Community, 'findById', async () => community);
  const req = {
    params: { id: community._id },
    body: { decision: 'approve' },
    roleUser: { _id: 'admin-1' },
    session: { flash: null }
  };
  const res = { redirect(path) { this.path = path; } };

  await adminController.reviewMonetization(req, res);

  assert.equal(community.monetizationStatus, 'pending');
  assert.match(req.session.flash.message, /moderator must clear/i);
  assert.equal(res.path, '/admin#communities');
});

test('admin monetization approval rejects an invalid community Waves share', async (t) => {
  const community = {
    _id: 'community-invalid-share',
    monetizationStatus: 'pending',
    monetizationModeratorReview: { status: 'cleared' },
    async save() {
      this.saved = true;
    }
  };
  t.mock.method(Community, 'findById', async () => community);
  const req = {
    params: { id: community._id },
    body: { decision: 'approve', revenueSharePercent: '100.001' },
    roleUser: { _id: 'admin-share' },
    session: { flash: null }
  };
  const res = { redirect(path) { this.path = path; } };

  await adminController.reviewMonetization(req, res);

  assert.equal(community.saved, undefined);
  assert.equal(community.monetizationStatus, 'pending');
  assert.match(req.session.flash.message, /between 0 and 100%/);
  assert.equal(res.path, '/admin#communities');
});

test('moderator screening is reasoned, excludes the community owner, and logs a clear decision', async (t) => {
  const community = {
    _id: 'community-screened',
    owner: 'owner-1',
    monetizationStatus: 'pending',
    monetizationModeratorReview: { status: 'pending' },
    monetizationHistory: [],
    async save() {}
  };
  t.mock.method(Community, 'findById', async () => community);
  t.mock.method(AuditLog, 'create', async (entry) => entry);
  const ownerReq = {
    params: { id: community._id },
    body: { decision: 'cleared', reason: 'Owner cannot review their own application.' },
    roleUser: { _id: 'owner-1' },
    session: { flash: null }
  };
  const res = { redirect(path) { this.path = path; } };
  await adminController.reviewCommunityMonetizationAsModerator(ownerReq, res);
  assert.match(ownerReq.session.flash.message, /cannot moderate your own/i);
  assert.equal(community.monetizationModeratorReview.status, 'pending');

  const req = {
    params: { id: community._id },
    body: { decision: 'cleared', reason: 'Eligibility and policy history reviewed.' },
    roleUser: { _id: 'moderator-1' },
    ip: '127.0.0.1',
    get: () => 'test-agent',
    session: { flash: null }
  };
  await adminController.reviewCommunityMonetizationAsModerator(req, res);

  assert.equal(community.monetizationModeratorReview.status, 'cleared');
  assert.equal(community.monetizationHistory.at(-1).action, 'moderator-cleared');
  assert.equal(res.path, '/moderator#monetization');
});
