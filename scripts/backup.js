#!/usr/bin/env node
// Wraps `mongodump` to produce a timestamped, gzipped archive, and prunes
// backups older than BACKUP_RETENTION_DAYS so disk usage doesn't grow
// unbounded. Requires the MongoDB Database Tools (mongodump) to be
// installed wherever this runs - they do NOT ship with the mongoose/
// mongodb npm packages, and are not installed in this sandbox, so this
// script has not been executed successfully here. See todo.txt Known Gaps.
//
// Usage:
//   node scripts/backup.js
//   MONGODB_URI=... BACKUP_DIR=./backups BACKUP_RETENTION_DAYS=14 node scripts/backup.js
//
// Typically scheduled via cron or your host's scheduled-job feature, e.g.
// a daily cron entry:
//   0 3 * * * cd /path/to/crowdwide && node scripts/backup.js >> /var/log/crowdwide-backup.log 2>&1

require('dotenv').config();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('../src/services/logger');

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS || 14);

function timestampedFilename() {
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  return `crowdwide-${iso}.archive.gz`;
}

function runMongodump(uri, outputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('mongodump', ['--uri', uri, '--archive', outputPath, '--gzip'], { stdio: 'inherit' });
    child.on('error', reject); // e.g. mongodump not installed (ENOENT)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`mongodump exited with code ${code}`))));
  });
}

function pruneOldBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const removed = [];
  for (const entry of fs.readdirSync(BACKUP_DIR)) {
    if (!entry.startsWith('crowdwide-') || !entry.endsWith('.archive.gz')) continue;
    const fullPath = path.join(BACKUP_DIR, entry);
    if (fs.statSync(fullPath).mtimeMs < cutoff) {
      fs.unlinkSync(fullPath);
      removed.push(entry);
    }
  }
  return removed;
}

async function main() {
  if (!process.env.MONGODB_URI) {
    logger.error('BACKUP_FAILED: MONGODB_URI is not set.');
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const filename = timestampedFilename();
  const outputPath = path.join(BACKUP_DIR, filename);

  try {
    await runMongodump(process.env.MONGODB_URI, outputPath);
    const sizeBytes = fs.statSync(outputPath).size;
    logger.info('Backup completed', { file: filename, sizeBytes });
  } catch (error) {
    logger.error('Backup failed', error);
    process.exitCode = 1;
    return;
  }

  const removed = pruneOldBackups();
  if (removed.length) logger.info('Pruned old backups', { removed, retentionDays: RETENTION_DAYS });
}

main();
