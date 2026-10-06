const { databaseStorageStats } = require('./storageCluster');
const logger = require('./logger');

const CACHE_MS = 60 * 1000;
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
let cachedResult;
let cachedAt = 0;

function combineStorageStats(clusterStats) {
  if (!clusterStats.length || clusterStats.some((stats) => (
    !Number.isFinite(stats.filesystemUsedBytes)
    || !Number.isFinite(stats.filesystemTotalBytes)
    || stats.filesystemUsedBytes < 0
    || stats.filesystemTotalBytes <= 0
  ))) {
    throw new Error('MongoDB did not return filesystem usage and capacity for every connected cluster.');
  }
  const usedBytes = clusterStats.reduce((total, stats) => total + stats.filesystemUsedBytes, 0);
  const capacityBytes = clusterStats.reduce((total, stats) => total + stats.filesystemTotalBytes, 0);
  const percentUsed = Math.round((usedBytes / capacityBytes) * 100);
  return {
    available: true,
    usedBytes,
    capacityBytes,
    remainingBytes: Math.max(0, capacityBytes - usedBytes),
    percentUsed,
    percentRemaining: Math.max(0, 100 - percentUsed),
    barPercent: Math.min(100, percentUsed),
    clusters: clusterStats.length
  };
}

async function getMongoStorage() {
  if (!cachedResult || Date.now() - cachedAt >= CACHE_MS) {
    try {
      cachedResult = combineStorageStats(await databaseStorageStats());
      cachedAt = Date.now();
    } catch (error) {
      logger.warn('MongoDB filesystem storage summary is unavailable.', error);
      cachedResult = { available: false };
      cachedAt = Date.now();
    }
  }
  return cachedResult;
}

function formatStorage(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unavailable';
  if (bytes < GIB) return `${Math.round(bytes / MIB).toLocaleString()} MB`;
  const gibibytes = bytes / GIB;
  return `${gibibytes.toFixed(gibibytes >= 10 ? 0 : 1)} GB`;
}

module.exports = { getMongoStorage, combineStorageStats, formatStorage };
