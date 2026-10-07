const test = require('node:test');
const assert = require('node:assert/strict');
const Community = require('../src/models/Community');
const SiteSetting = require('../src/models/SiteSetting');
const User = require('../src/models/User');
const WavesLedgerEntry = require('../src/models/WavesLedgerEntry');
const { getActiveCommunityPromotions, promoteCommunity } = require('../src/services/communityPromotion');

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

function stubPromotionModels(t, {
  reservation,
  existing,
  owner = { isVerified: true, wavesBalance: 100 },
  activated = { modifiedCount: 1 }
} = {}) {
  const calls = { ledger: [], debitFilter: null, activation: null, release: null };
  t.mock.method(SiteSetting, 'getSingleton', async () => ({
    communityPromotionEnabled: true,
    communityPromotionWavesCost: 50,
    communityPromotionDurationHours: 48
  }));
  t.mock.method(Community, 'findOneAndUpdate', () => ({
    select: () => Promise.resolve(reservation === undefined ? { _id: 'community-1' } : reservation)
  }));
  t.mock.method(Community, 'findById', () => query(existing || reservation || {
    owner: 'owner-1', isPrivate: false, promotionStatus: 'active'
  }));
  t.mock.method(Community, 'updateOne', async (filter, update) => {
    if (update.$set?.promotionStatus === 'active') calls.activation = { filter, update };
    else calls.release = { filter, update };
    return update.$set?.promotionStatus === 'active' ? activated : { modifiedCount: 1 };
  });
  t.mock.method(User, 'findOneAndUpdate', (filter) => {
    calls.debitFilter = filter;
    return thenableQuery(owner);
  });
  t.mock.method(User, 'findById', () => query(owner));
  t.mock.method(User, 'find', () => query([{ _id: 'owner-1' }]));
  t.mock.method(WavesLedgerEntry, 'create', async (entry) => {
    calls.ledger.push(entry);
    entry.save = async function save() {};
    return entry;
  });
  return calls;
}

test('community owner promotion charges Waves and activates a labeled placement', async (t) => {
  const calls = stubPromotionModels(t);
  const now = new Date('2026-10-07T07:00:00Z');
  const result = await promoteCommunity({ communityId: 'community-1', userId: 'owner-1', now });

  assert.equal(result.wavesCost, 50);
  assert.equal(result.durationHours, 48);
  assert.equal(result.endsAt.toISOString(), '2026-10-09T07:00:00.000Z');
  assert.equal(calls.debitFilter.isVerified, true);
  assert.equal(calls.debitFilter.wavesBalance.$gte, 50);
  assert.equal(calls.ledger[0].status, 'posted');
  assert.equal(calls.ledger[0].referenceType, 'community-promotion');
  assert.equal(calls.activation.update.$set.promotionStatus, 'active');
});

test('private communities cannot be promoted or charged', async (t) => {
  const calls = stubPromotionModels(t, {
    reservation: null,
    existing: { owner: 'owner-1', isPrivate: true, promotionStatus: 'disabled' },
    owner: { isVerified: true, wavesBalance: 100 },
  });
  await assert.rejects(
    promoteCommunity({ communityId: 'community-1', userId: 'owner-1' }),
    /Private communities cannot be promoted/
  );
  assert.equal(calls.debitFilter, null);
  assert.equal(calls.ledger.length, 0);
});

test('insufficient Waves reverses the pending spend and releases the community reservation', async (t) => {
  const calls = stubPromotionModels(t, { owner: null });
  User.findById = () => query({ isVerified: true, wavesBalance: 10 });
  await assert.rejects(
    promoteCommunity({ communityId: 'community-1', userId: 'owner-1' }),
    /not have enough Waves/
  );
  assert.equal(calls.ledger[0].status, 'reversed');
  assert.equal(calls.release.update.$set.promotionStatus, 'disabled');
});

test('active community promotions are restricted to public communities and labeled in results', async (t) => {
  let filter;
  const rows = [{ _id: 'community-1', owner: 'owner-1', isPrivate: false }];
  t.mock.method(Community, 'find', (match) => {
    filter = match;
    return { sort() { return this; }, lean: async () => rows };
  });
  t.mock.method(User, 'find', () => query([{ _id: 'owner-1' }]));
  const active = await getActiveCommunityPromotions({ now: new Date('2026-10-07T07:00:00Z') });
  assert.equal(filter.isPrivate, false);
  assert.equal(filter.promotionStatus, 'active');
  assert.equal(active[0].isPromoted, true);
});
