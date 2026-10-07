#!/usr/bin/env node

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');
const WavesLedgerEntry = require('../src/models/WavesLedgerEntry');
const logger = require('../src/services/logger');

const CONFIRMATION_FLAG = '--confirm-reset-waves';

async function resetWaves() {
  const session = await mongoose.startSession();
  let counts;
  try {
    await session.withTransaction(async () => {
      const users = await User.updateMany({}, {
        $set: {
          wavesBalance: 0,
          wavesTotalEarned: 0,
          wavesTotalSpent: 0
        }
      }, { session });
      const ledger = await WavesLedgerEntry.deleteMany({}, { session });
      counts = {
        usersMatched: users.matchedCount,
        usersUpdated: users.modifiedCount,
        ledgerEntriesDeleted: ledger.deletedCount
      };
    });
    return counts;
  } finally {
    await session.endSession();
  }
}

async function main() {
  if (!process.argv.includes(CONFIRMATION_FLAG)) {
    logger.error(`Refusing to reset Waves data. Rerun with ${CONFIRMATION_FLAG} to confirm.`);
    process.exitCode = 1;
    return;
  }
  if (!process.env.MONGODB_URI) {
    logger.error('Waves reset failed: MONGODB_URI is not set.');
    process.exitCode = 1;
    return;
  }

  try {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    const counts = await resetWaves();
    logger.info('Waves reset completed', counts);
  } catch (error) {
    logger.error('Waves reset failed; no partial changes were committed.', error);
    process.exitCode = 1;
  } finally {
    try {
      await mongoose.disconnect();
    } catch (error) {
      logger.error('Could not close the MongoDB connection after the Waves reset.', error);
      process.exitCode = 1;
    }
  }
}

if (require.main === module) main();

module.exports = { resetWaves };
