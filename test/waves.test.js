const test = require('node:test');
const assert = require('node:assert/strict');

const User = require('../src/models/User');
const SiteSetting = require('../src/models/SiteSetting');
const WavesLedgerEntry = require('../src/models/WavesLedgerEntry');
const WavesAbuseSignal = require('../src/models/WavesAbuseSignal');
const { creditWaves, creditCommunityAdShare, debitWaves, transferWaves, adjustWaves, rewardWavesForAction, getReciprocalRewardSignals } = require('../src/services/waves');

test('creditWaves updates balance and total earned', async (t) => {
  const user = {
    wavesBalance: 10,
    wavesTotalEarned: 40,
    wavesTotalSpent: 5,
    async save() {
      return this;
    }
  };

  const findById = t.mock.method(User, 'findById', async () => user);
  const createEntry = t.mock.method(WavesLedgerEntry, 'create', async (entry) => entry);

  const updated = await creditWaves({
    userId: 'u-1',
    amount: 25,
    description: 'Post reward',
    reason: 'Posted a community update',
    actorId: 'admin-1'
  });

  assert.equal(updated.wavesBalance, 35);
  assert.equal(updated.wavesTotalEarned, 65);
  assert.equal(findById.mock.callCount(), 1);
  assert.equal(createEntry.mock.callCount(), 1);
  assert.equal(createEntry.mock.calls[0].arguments[0].type, 'earn');
});

test('community ad shares are credited once with community and event ledger references', async (t) => {
  const user = {
    isVerified: true,
    wavesBalance: 8,
    wavesTotalEarned: 12,
    async save() { return this; }
  };
  const claim = {
    _id: 'share-ledger-1',
    async save() { return this; }
  };
  let ledgerEntry;
  const create = t.mock.method(WavesLedgerEntry, 'create', async (entry) => {
    ledgerEntry = entry;
    return entry;
  });
  const acquire = t.mock.method(WavesLedgerEntry, 'findOneAndUpdate', async (query, update) => {
    assert.equal(query.rewardKey, 'community-ad-share:event-1');
    assert.equal(update.$set.status, 'processing');
    return claim;
  });
  t.mock.method(User, 'findById', async () => user);

  const result = await creditCommunityAdShare({
    userId: 'owner-1',
    amount: 0.75,
    communityId: 'community-1',
    eventId: 'event-1',
    viewerId: 'viewer-1',
    revenueSharePercent: 50
  });

  assert.equal(result.amount, 0.75);
  assert.equal(result.balance, 8.75);
  assert.equal(user.wavesTotalEarned, 12.75);
  assert.equal(ledgerEntry.community, 'community-1');
  assert.equal(ledgerEntry.referenceType, 'community-ad-share');
  assert.equal(ledgerEntry.referenceId, 'event-1');
  assert.equal(ledgerEntry.actor, 'viewer-1');
  assert.equal(ledgerEntry.rewardKey, 'community-ad-share:event-1');
  assert.equal(claim.status, 'posted');
  assert.equal(acquire.mock.callCount(), 1);
  assert.equal(create.mock.callCount(), 1);
});

test('community ad share retries do not credit a previously posted event twice', async (t) => {
  const duplicateError = Object.assign(new Error('duplicate key'), { code: 11000 });
  t.mock.method(WavesLedgerEntry, 'create', async () => { throw duplicateError; });
  t.mock.method(WavesLedgerEntry, 'findOneAndUpdate', async () => null);
  t.mock.method(WavesLedgerEntry, 'findOne', () => ({ lean: async () => ({ status: 'posted' }) }));
  t.mock.method(User, 'findById', async () => {
    throw new Error('Posted shares must not reload the owner.');
  });

  const result = await creditCommunityAdShare({
    userId: 'owner-1',
    amount: 0.75,
    communityId: 'community-1',
    eventId: 'event-1',
    revenueSharePercent: 50
  });

  assert.deepEqual(result, { amount: 0, duplicate: true, pending: false });
});

test('transferWaves rejects self-transfers and debits/credits both accounts', async (t) => {
  const fromUser = {
    _id: 'from',
    wavesBalance: 50,
    wavesTotalEarned: 100,
    wavesTotalSpent: 20,
    async save() {
      return this;
    }
  };
  const toUser = {
    _id: 'to',
    wavesBalance: 12,
    wavesTotalEarned: 20,
    wavesTotalSpent: 2,
    async save() {
      return this;
    }
  };

  t.mock.method(SiteSetting, 'getSingleton', async () => ({
    wavesMaxTransferAmount: 100,
    wavesDailyTransferLimit: 500
  }));
  t.mock.method(WavesLedgerEntry, 'aggregate', async () => []);
  t.mock.method(User, 'findById', async (id) => (String(id) === 'from' ? fromUser : toUser));
  t.mock.method(WavesLedgerEntry, 'create', async (entry) => entry);

  await assert.rejects(() => transferWaves({
    fromUserId: 'from',
    toUserId: 'from',
    amount: 5,
    description: 'Self transfer'
  }), /cannot transfer/i);

  const result = await transferWaves({
    fromUserId: 'from',
    toUserId: 'to',
    amount: 10,
    description: 'For the team',
    actorId: 'admin-2'
  });

  assert.equal(fromUser.wavesBalance, 40);
  assert.equal(toUser.wavesBalance, 22);
  assert.equal(result.amount, 10);
});

test('transferWaves enforces configured per-transfer and daily limits', async (t) => {
  t.mock.method(SiteSetting, 'getSingleton', async () => ({
    wavesMaxTransferAmount: 10,
    wavesDailyTransferLimit: 15
  }));
  t.mock.method(User, 'findById', async (id) => ({
    _id: id,
    wavesBalance: 100,
    wavesTotalEarned: 100,
    wavesTotalSpent: 0,
    async save() {
      return this;
    }
  }));
  t.mock.method(WavesLedgerEntry, 'aggregate', async () => [{ total: 10 }]);
  const ledgerCreate = t.mock.method(WavesLedgerEntry, 'create', async (entry) => entry);

  await assert.rejects(() => transferWaves({
    fromUserId: 'from',
    toUserId: 'to',
    amount: 11
  }), /cannot exceed 10 Waves/i);
  await assert.rejects(() => transferWaves({
    fromUserId: 'from',
    toUserId: 'to',
    amount: 6
  }), /daily transfer limit is 15 Waves/i);
  assert.equal(ledgerCreate.mock.callCount(), 0);
});

test('rapid repeated Waves transfers create an admin review signal without blocking the transfer', async (t) => {
  const accounts = {
    from: { _id: 'from', wavesBalance: 50, wavesTotalEarned: 0, wavesTotalSpent: 0, async save() { return this; } },
    to: { _id: 'to', wavesBalance: 10, wavesTotalEarned: 0, wavesTotalSpent: 0, async save() { return this; } }
  };
  t.mock.method(SiteSetting, 'getSingleton', async () => ({
    wavesMaxTransferAmount: 100, wavesDailyTransferLimit: 500
  }));
  let aggregateCall = 0;
  t.mock.method(WavesLedgerEntry, 'aggregate', async () => {
    aggregateCall += 1;
    return aggregateCall === 1 ? [] : [{ _id: 'to', count: 5, totalWaves: 35 }];
  });
  t.mock.method(User, 'findById', async (id) => accounts[String(id)]);
  t.mock.method(WavesLedgerEntry, 'create', async (entry) => entry);
  const signalUpdate = t.mock.method(WavesAbuseSignal, 'findOneAndUpdate', async (_query, update) => update);

  const result = await transferWaves({ fromUserId: 'from', toUserId: 'to', amount: 5 });

  assert.equal(result.amount, 5);
  assert.equal(accounts.from.wavesBalance, 45);
  assert.equal(accounts.to.wavesBalance, 15);
  assert.equal(signalUpdate.mock.callCount(), 1);
  assert.equal(signalUpdate.mock.calls[0].arguments[1].$setOnInsert.sender, 'from');
  assert.equal(signalUpdate.mock.calls[0].arguments[1].$setOnInsert.recipient, 'to');
  assert.match(signalUpdate.mock.calls[0].arguments[1].$set.reason, /5 transfers within ten minutes/);
});

test('a temporary Waves hold prevents earning and spending while preserving admin adjustments', async (t) => {
  const user = {
    _id: 'held-user',
    wavesBalance: 20,
    wavesTotalEarned: 20,
    wavesTotalSpent: 0,
    wavesSuspendedUntil: new Date(Date.now() + 60_000),
    async save() { return this; }
  };
  t.mock.method(User, 'findById', async () => user);
  t.mock.method(SiteSetting, 'getSingleton', async () => ({
    wavesPostReward: { minimum: 1, maximum: 1 },
    wavesDailyEarningLimit: 20
  }));
  t.mock.method(WavesLedgerEntry, 'aggregate', async () => []);
  let rewardClaim;
  const createEntry = t.mock.method(WavesLedgerEntry, 'create', async (entry) => {
    rewardClaim = { ...entry, async save() { return this; } };
    return rewardClaim;
  });

  await assert.rejects(() => debitWaves({
    userId: 'held-user',
    amount: 2,
    description: 'Spend while held'
  }), /temporarily held from spending/i);
  await assert.rejects(() => rewardWavesForAction({
    userId: 'held-user',
    action: 'post',
    referenceType: 'post',
    referenceId: 'post-held'
  }), /temporarily held from earning/i);
  assert.equal(createEntry.mock.callCount(), 1);
  assert.equal(rewardClaim.status, 'reversed');

  await adjustWaves({ userId: 'held-user', delta: -1, reason: 'Correct fraud loss', actorId: 'admin' });
  assert.equal(createEntry.mock.callCount(), 2);
});

test('rewardWavesForAction credits within the configured range and daily cap', async (t) => {
  const user = {
    wavesBalance: 10,
    wavesTotalEarned: 10,
    wavesTotalSpent: 0,
    async save() {
      return this;
    }
  };
  t.mock.method(SiteSetting, 'getSingleton', async () => ({
    wavesPostReward: { minimum: 2, maximum: 2 },
    wavesDailyEarningLimit: 5
  }));
  t.mock.method(WavesLedgerEntry, 'aggregate', async () => [{ total: 4 }]);
  t.mock.method(User, 'findById', async () => user);
  let createdClaim;
  const createEntry = t.mock.method(WavesLedgerEntry, 'create', async (entry) => {
    createdClaim = {
      ...entry,
      async save() {
        return this;
      }
    };
    return createdClaim;
  });

  const result = await rewardWavesForAction({
    userId: 'u-2',
    action: 'post',
    referenceType: 'post',
    referenceId: 'p-1'
  });

  assert.equal(result.amount, 1);
  assert.equal(user.wavesBalance, 11);
  assert.equal(createEntry.mock.calls[0].arguments[0].amount, 1);
  assert.equal(createdClaim.status, 'posted');
});

test('rewardWavesForAction does not credit beyond the daily limit', async (t) => {
  t.mock.method(SiteSetting, 'getSingleton', async () => ({
    wavesCommentReward: { minimum: 1, maximum: 3 },
    wavesDailyEarningLimit: 5
  }));
  t.mock.method(WavesLedgerEntry, 'aggregate', async () => [{ total: 5 }]);
  const findUser = t.mock.method(User, 'findById', async () => {
    throw new Error('A capped reward must not load or modify the wallet.');
  });

  const result = await rewardWavesForAction({ userId: 'u-3', action: 'comment' });

  assert.deepEqual(result, { amount: 0, balance: null });
  assert.equal(findUser.mock.callCount(), 0);
});

test('received engagement rewards reject self-interactions and duplicate claims', async (t) => {
  t.mock.method(SiteSetting, 'getSingleton', async () => ({
    wavesLikeReward: { minimum: 1, maximum: 1 },
    wavesDailyEarningLimit: 20
  }));
  const aggregation = t.mock.method(WavesLedgerEntry, 'aggregate', async () => [{ total: 0 }]);
  const findUser = t.mock.method(User, 'findById', async () => ({
    wavesBalance: 0,
    wavesTotalEarned: 0,
    async save() {
      return this;
    }
  }));
  const createdClaim = {
    amount: 1,
    status: 'pending',
    async save() {
      return this;
    }
  };
  const createClaim = t.mock.method(WavesLedgerEntry, 'create', async () => createdClaim);

  const selfReward = await rewardWavesForAction({
    userId: 'u-4',
    actorId: 'u-4',
    action: 'receivedLike',
    referenceType: 'post',
    referenceId: 'p-4'
  });

  assert.deepEqual(selfReward, { amount: 0, balance: null });
  assert.equal(aggregation.mock.callCount(), 0);

  const earned = await rewardWavesForAction({
    userId: 'u-4',
    actorId: 'u-5',
    action: 'receivedLike',
    referenceType: 'post',
    referenceId: 'p-4'
  });
  assert.equal(earned.amount, 1);
  assert.equal(createdClaim.status, 'posted');
  assert.equal(createClaim.mock.callCount(), 1);
  assert.equal(findUser.mock.callCount(), 1);

  const duplicateClaim = new Error('duplicate key');
  duplicateClaim.code = 11000;
  createClaim.mock.mockImplementationOnce(async () => {
    throw duplicateClaim;
  });
  const duplicate = await rewardWavesForAction({
    userId: 'u-4',
    actorId: 'u-5',
    action: 'receivedLike',
    referenceType: 'post',
    referenceId: 'p-4'
  });
  assert.deepEqual(duplicate, { amount: 0, balance: null });
  assert.equal(findUser.mock.callCount(), 1);
});

test('reciprocal Waves reward signals require repeated two-way activity on multiple targets and days', async (t) => {
  let pipeline;
  t.mock.method(WavesLedgerEntry, 'aggregate', async (stages) => {
    pipeline = stages;
    return [{
      _id: { accountA: 'user-a', accountB: 'user-b' },
      totalRewards: 10, rewardsFromA: 5, rewardsFromB: 5,
      uniqueTargets: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
      activeDays: ['2026-10-01', '2026-10-03'],
      totalWaves: 16.25
    }];
  });
  t.mock.method(User, 'find', () => ({
    select() { return this; },
    lean: async () => [{ _id: 'user-a', name: 'Asha' }, { _id: 'user-b', name: 'Ravi' }]
  }));

  const signals = await getReciprocalRewardSignals(new Date('2026-10-07T00:00:00Z'));

  assert.deepEqual(signals, [{
    accountA: { id: 'user-a', name: 'Asha' },
    accountB: { id: 'user-b', name: 'Ravi' },
    totalRewards: 10, rewardsFromA: 5, rewardsFromB: 5,
    activeDays: 2, uniqueTargets: 6, totalWaves: 16.25
  }]);
  assert.deepEqual(pipeline[0].$match.description.$in, ['Received like reward', 'Received comment reward']);
  assert.equal(pipeline[0].$match.createdAt.$gte.toISOString(), '2026-09-07T00:00:00.000Z');
  assert.equal(pipeline[3].$match.totalRewards.$gte, 8);
  assert.equal(pipeline[3].$match.rewardsFromA.$gte, 3);
});
