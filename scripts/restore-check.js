#!/usr/bin/env node
// A backup you've never restored is a backup you don't actually have.
// This restores a given archive into a throwaway scratch database (never
// touching the real one), runs a few basic sanity checks against it, then
// drops the scratch database. Requires mongorestore and a reachable
// MongoDB server - not available in this sandbox, so this has not been
// executed successfully here. See todo.txt Known Gaps.
//
// Usage:
//   node scripts/restore-check.js ./backups/crowdwide-2026-09-15.archive.gz
//   MONGODB_URI=mongodb://localhost:27017 node scripts/restore-check.js <archive>
//
// Exits non-zero (and is safe to wire into a scheduled job/CI step that
// alerts on failure) if the restore fails or the restored data looks empty
// or implausible.

require('dotenv').config();
const { spawn } = require('child_process');
const mongoose = require('mongoose');
const logger = require('../src/services/logger');

const archivePath = process.argv[2];
const baseUri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const scratchDbName = `crowdwide-restore-check-${Date.now()}`;

function runMongorestore(uri, archive) {
  return new Promise((resolve, reject) => {
    const child = spawn('mongorestore', ['--uri', uri, '--archive', archive, '--gzip', '--drop'], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`mongorestore exited with code ${code}`))));
  });
}

// Swap the database name in a mongo URI without disturbing auth/host/query
// params, so the scratch restore always lands on scratchDbName regardless
// of what database the original backup connection string pointed at.
function withDatabase(uri, dbName) {
  const parsed = new URL(uri);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

async function main() {
  if (!archivePath) {
    logger.error('Usage: node scripts/restore-check.js <path-to-archive>');
    process.exitCode = 1;
    return;
  }

  const scratchUri = withDatabase(baseUri, scratchDbName);
  let connection;
  try {
    logger.info('Restoring backup into a scratch database for verification', { scratchDbName, archivePath });
    await runMongorestore(scratchUri, archivePath);

    connection = await mongoose.createConnection(scratchUri).asPromise();
    const collections = await connection.db.listCollections().toArray();
    const collectionNames = collections.map((c) => c.name);

    // A restore that produced zero collections, or is missing accounts
    // entirely, is not a usable backup even if mongorestore exited 0.
    if (!collectionNames.length) throw new Error('Restored database has no collections.');
    if (!collectionNames.includes('users')) throw new Error('Restored database is missing the users collection.');

    const counts = {};
    for (const name of ['users', 'posts', 'communities']) {
      if (collectionNames.includes(name)) {
        // eslint-disable-next-line no-await-in-loop
        counts[name] = await connection.db.collection(name).countDocuments();
      }
    }
    logger.info('Restore check passed', { collections: collectionNames.length, counts });
  } catch (error) {
    logger.error('Restore check FAILED - this backup may not be usable in an actual disaster recovery', error);
    process.exitCode = 1;
  } finally {
    if (connection) {
      await connection.dropDatabase().catch((error) => logger.error('Failed to drop scratch database after restore check', error));
      await connection.close().catch(() => {});
    }
  }
}

main();
