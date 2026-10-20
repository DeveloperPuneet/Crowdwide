const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Post = require('../src/models/Post');
const community = require('../src/controllers/communityController');

const mockRes = () => { const r = { body: null, redirected: null, json(b) { r.body = b; return r; }, redirect(u) { r.redirected = u; return r; } }; return r; };
const xhr = { get: (h) => (h === 'X-Requested-With' ? 'XMLHttpRequest' : undefined) };

test('community review answers JSON for background requests and does not flash', async () => {
  const saved = [];
  Post.findOne = async () => ({ status: 'pending', save: async function () { saved.push(this.status); } });
  Post.countDocuments = async () => 2;
  const req = { ...xhr, params: { postId: 'p1' }, body: { decision: 'approve' }, community: { _id: 'c1' }, session: {} };
  const res = mockRes();
  await community.reviewPost(req, res);
  assert.deepEqual(saved, ['published']);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.remove, true);
  assert.equal(res.body.pending, 2);
  assert.equal(req.session.flash, undefined);
});

test('community review still redirects for plain form posts', async () => {
  Post.findOne = async () => null;
  const req = { get: () => undefined, params: { postId: 'p1' }, body: { decision: 'reject' }, community: { _id: 'c1' }, session: {} };
  const res = mockRes();
  await community.reviewPost(req, res);
  assert.equal(res.redirected, '/communities/c1/manage');
});

test('moderation pages hook into the live-review script', () => {
  assert.match(fs.readFileSync('src/views/pages/moderator.ejs', 'utf8'), /data-live-item/);
  assert.match(fs.readFileSync('src/views/pages/community-owner.ejs', 'utf8'), /data-review-queue-url/);
  assert.match(fs.readFileSync('src/views/partials/foot.ejs', 'utf8'), /live-review\.js/);
});
