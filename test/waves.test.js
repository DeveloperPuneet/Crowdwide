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
  const createEntry = t.mock.method(WavesLedgerEntry, 'create', async (entry) => entry);

  const result = await rewardWavesForAction({
    userId: 'u-2',
    action: 'post',
    referenceType: 'post',
    referenceId: 'p-1'
  });

  assert.equal(result.amount, 1);
  assert.equal(user.wavesBalance, 11);
  assert.equal(createEntry.mock.calls[0].arguments[0].amount, 1);
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
