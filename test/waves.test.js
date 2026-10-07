const test = require('node:test');
const assert = require('node:assert/strict');

const User = require('../src/models/User');
const SiteSetting = require('../src/models/SiteSetting');
const WavesLedgerEntry = require('../src/models/WavesLedgerEntry');
const { creditWaves, transferWaves, rewardWavesForAction } = require('../src/services/waves');

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
