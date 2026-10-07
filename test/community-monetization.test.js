const test = require('node:test');
const assert = require('node:assert/strict');

const Post = require('../src/models/Post');
const SiteSetting = require('../src/models/SiteSetting');
const communityController = require('../src/controllers/communityController');

test('monetization eligibility uses configured published-post totals', async (t) => {
  t.mock.method(SiteSetting, 'getSingleton', async () => ({
    monetizationMinimumPosts: 20,
    monetizationMinimumLikes: 30,
    monetizationMinimumComments: 10
  }));
  t.mock.method(Post, 'aggregate', async () => [{ posts: 20, likes: 30, comments: 9 }]);

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
  t.mock.method(Post, 'aggregate', async () => [{ posts: 19, likes: 30, comments: 10 }]);

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
  t.mock.method(Post, 'aggregate', async () => [{ posts: 20, likes: 30, comments: 10 }]);

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
