const mongoose = require('mongoose');
const { initStorageClusters } = require('../services/storageCluster');
const logger = require('../services/logger');

async function connectDatabase() {
  if (!process.env.MONGODB_URI) {
    logger.warn('MONGODB_URI is not set. Running with database features disabled.');
    return;
  }

  // Fail fast instead of hanging. Without these, a database that is
  // unreachable (Atlas IP allow-list, paused free cluster, cold start) makes
  // every request wait ~10s in mongoose's buffer and ~30s in server
  // selection before showing "temporarily unavailable" - which is exactly
  // what "sign in is taking too long" looks like from the browser.
  mongoose.set('bufferTimeoutMS', 5000);
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected.'));
  mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected.'));
  mongoose.connection.on('error', (error) => logger.error('MongoDB connection error', error));

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  logger.info('Connected to MongoDB (primary cluster).');

  // Bring any extended storage clusters (MONGO_DB_URL_0, MONGO_DB_URL_1, ...)
  // online so post/profile media can be distributed across them.
  await initStorageClusters();
}

module.exports = connectDatabase;
