const test = require('node:test');
const assert = require('node:assert/strict');

const mongoose = require('mongoose');
const User = require('../src/models/User');
const WavesLedgerEntry = require('../src/models/WavesLedgerEntry');
const { resetWaves } = require('../scripts/reset-waves');

test('resetWaves zeros user totals and deletes the Waves ledger in one transaction', async (t) => {
  const session = {
    async withTransaction(callback) {
      await callback();
    },
    async endSession() {}
  };
  let userUpdate;
  let ledgerDeleteOptions;

  t.mock.method(mongoose, 'startSession', async () => session);
  t.mock.method(User, 'updateMany', async (...args) => {
    userUpdate = args;
    return { matchedCount: 4, modifiedCount: 3 };
  });
  t.mock.method(WavesLedgerEntry, 'deleteMany', async (...args) => {
    ledgerDeleteOptions = args;
    return { deletedCount: 12 };
  });

  const result = await resetWaves();

  assert.deepEqual(userUpdate[0], {});
  assert.deepEqual(userUpdate[1], {
    $set: { wavesBalance: 0, wavesTotalEarned: 0, wavesTotalSpent: 0 }
  });
  assert.equal(userUpdate[2].session, session);
  assert.deepEqual(ledgerDeleteOptions[0], {});
  assert.equal(ledgerDeleteOptions[1].session, session);
  assert.deepEqual(result, {
    usersMatched: 4,
    usersUpdated: 3,
    ledgerEntriesDeleted: 12
  });
});
