const test = require('node:test');
const assert = require('node:assert/strict');
const { combineStorageStats, formatStorage } = require('../src/services/mongoStorage');

test('MongoDB storage combines filesystem usage and capacity across all clusters', () => {
  const summary = combineStorageStats([
    { filesystemUsedBytes: 256 * 1024 ** 2, filesystemTotalBytes: 356 * 1024 ** 2 },
    { filesystemUsedBytes: 256 * 1024 ** 2, filesystemTotalBytes: 356 * 1024 ** 2 }
  ]);

  assert.equal(summary.usedBytes, 512 * 1024 ** 2);
  assert.equal(summary.capacityBytes, 712 * 1024 ** 2);
  assert.equal(summary.remainingBytes, 200 * 1024 ** 2);
  assert.equal(summary.percentUsed, 72);
  assert.equal(summary.percentRemaining, 28);
  assert.equal(summary.barPercent, 72);
  assert.equal(summary.clusters, 2);
  assert.equal(formatStorage(summary.usedBytes), '512 MB');
  assert.equal(formatStorage(summary.capacityBytes), '712 MB');
});

test('MongoDB storage rejects missing filesystem capacity stats', () => {
  assert.throws(() => combineStorageStats([]), /did not return filesystem usage and capacity/);
  assert.throws(
    () => combineStorageStats([{ filesystemUsedBytes: 10, filesystemTotalBytes: 0 }]),
    /did not return filesystem usage and capacity/
  );
});

test('MongoDB storage clamps the meter when filesystem usage exceeds reported capacity', () => {
  const summary = combineStorageStats([
    { filesystemUsedBytes: 600 * 1024 ** 2, filesystemTotalBytes: 512 * 1024 ** 2 }
  ]);
  assert.equal(summary.percentUsed, 117);
  assert.equal(summary.percentRemaining, 0);
  assert.equal(summary.barPercent, 100);
  assert.equal(summary.remainingBytes, 0);
});
