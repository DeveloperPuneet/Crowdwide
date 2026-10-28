const mongoose = require('mongoose');
const logger = require('./logger');

// WideWave was removed from Crowdwide. This one-time, idempotent cleanup runs at start-up so that
// posts which used to live in a WideWave simply become normal posts and no WideWave data is left behind.
async function removeWideWaveData() {
  const db = mongoose.connection?.db;
  if (!db) return { skipped: true };
  const result = { postsConverted: 0, collectionDropped: false, indexDropped: false };
  try {
    const posts = db.collection('posts');
    const converted = await posts.updateMany({ widewave: { $exists: true } }, { $unset: { widewave: '' } });
    result.postsConverted = converted.modifiedCount || 0;
    try {
      await posts.dropIndex('widewave_1_status_1_createdAt_-1');
      result.indexDropped = true;
    } catch (error) {
      if (error.codeName !== 'IndexNotFound' && error.code !== 27 && error.code !== 26) throw error;
    }
    const collections = await db.listCollections({ name: 'widewaves' }, { nameOnly: true }).toArray();
    if (collections.length) {
      await db.dropCollection('widewaves');
      result.collectionDropped = true;
    }
    await db.collection('sitesettings').updateMany({ widewavesEnabled: { $exists: true } }, { $unset: { widewavesEnabled: '' } });
    if (result.postsConverted || result.collectionDropped) logger.info(`WideWave cleanup: ${result.postsConverted} posts are now normal posts.`);
  } catch (error) {
    logger.error('WideWave cleanup failed (will retry on next start)', error);
  }
  return result;
}

module.exports = { removeWideWaveData };
