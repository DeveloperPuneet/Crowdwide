const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../src/models/User');
const Post = require('../src/models/Post');
const SiteSetting = require('../src/models/SiteSetting');
const WavesLedgerEntry = require('../src/models/WavesLedgerEntry');
const { promotePost } = require('../src/services/postPromotion');

function query(value) {
  return {
    select() { return this; },
    lean: async () => value
  };
}

function thenableQuery(value) {
  return {
    select() { return this; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); }
  };
}

function stubPromotionModels(t, { reservation, account = { wavesBalance: 75 }, activated = { modifiedCount: 1 } } = {}) {
  const originals = {
    setting: SiteSetting.getSingleton,
    findOneAndUpdatePost: Post.findOneAndUpdate,
    findByIdPost: Post.findById,
    updateOnePost: Post.updateOne,
    findOneAndUpdateUser: User.findOneAndUpdate,
    findByIdUser: User.findById,
    createLedger: WavesLedgerEntry.create
  };
  const calls = { ledger: [], debitFilter: null, activation: null, release: null };
  SiteSetting.getSingleton = async () => ({ postPromotionEnabled: true, postPromotionWavesCost: 25, postPromotionDurationHours: 24 });
  Post.findOneAndUpdate = () => query(reservation === undefined
    ? { community: null, body: 'A thoughtful post', media: [] }
    : reservation);
  Post.findById = () => query(reservation || { author: 'owner', status: 'published', moderationStatus: 'good', boostStatus: 'active' });
  Post.updateOne = async (filter, update) => {
    if (update.$set?.boostStatus === 'active') calls.activation = { filter, update };
    else calls.release = { filter, update };
    return update.$set?.boostStatus === 'active' ? activated : { modifiedCount: 1 };
  };
  User.findOneAndUpdate = (filter) => {
    calls.debitFilter = filter;
    return thenableQuery(account);
  };
  User.findById = () => query(account);
  WavesLedgerEntry.create = async (entry) => {
    calls.ledger.push(entry);
    return { ...entry, save: async function save() {} };
  };
  t.after(() => {
    SiteSetting.getSingleton = originals.setting;
    Post.findOneAndUpdate = originals.findOneAndUpdatePost;
    Post.findById = originals.findByIdPost;
    Post.updateOne = originals.updateOnePost;
    User.findOneAndUpdate = originals.findOneAndUpdateUser;
    User.findById = originals.findByIdUser;
    WavesLedgerEntry.create = originals.createLedger;
  });
  return calls;
}

test('promoting an owned eligible post atomically charges Waves and records a paid promotion', async (t) => {
  const calls = stubPromotionModels(t);
  const now = new Date('2026-09-20T12:00:00Z');
  const result = await promotePost({ postId: 'post-1', userId: 'owner', now });

  assert.equal(result.wavesCost, 25);
  assert.equal(result.durationHours, 24);
  assert.equal(result.endsAt.toISOString(), '2026-09-21T12:00:00.000Z');
  assert.equal(calls.debitFilter.wavesBalance.$gte, 25);
  assert.equal(calls.ledger[0].type, 'spend');
  assert.equal(calls.ledger[0].amount, -25);
  assert.equal(calls.ledger[0].referenceType, 'post-promotion');
  assert.equal(calls.activation.update.$set.boostStatus, 'active');
  assert.equal(calls.activation.update.$set.boostWavesCost, 25);
});

test('an active promotion cannot be purchased again', async (t) => {
  stubPromotionModels(t, { reservation: null });
  await assert.rejects(
    promotePost({ postId: 'post-1', userId: 'owner' }),
    /already has an active promotion/
  );
});

test('insufficient Waves release the reserved post promotion without a ledger debit', async (t) => {
  const calls = stubPromotionModels(t, { account: null });
  User.findById = () => query({ wavesBalance: 5 });
  await assert.rejects(
    promotePost({ postId: 'post-1', userId: 'owner' }),
    /not have enough Waves/
  );
  assert.equal(calls.ledger.length, 0);
  assert.equal(calls.release.update.$set.boostStatus, 'disabled');
});
