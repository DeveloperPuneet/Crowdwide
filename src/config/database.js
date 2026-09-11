const mongoose = require('mongoose');
const { initStorageClusters } = require('../services/storageCluster');

async function connectDatabase() {
  if (!process.env.MONGODB_URI) {
    console.warn('MONGODB_URI is not set. Running with database features disabled.');
    return;
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB (primary cluster).');

  // Bring any extended storage clusters (MONGO_DB_URL_0, MONGO_DB_URL_1, ...)
  // online so post/profile media can be distributed across them.
  await initStorageClusters();
}

module.exports = connectDatabase;
