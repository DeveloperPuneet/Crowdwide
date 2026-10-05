const cron = require('node-cron');
const Message = require('../models/Message');
const GroupMessage = require('../models/GroupMessage');
const Notification = require('../models/Notification');
const SearchEvent = require('../models/SearchEvent');
const User = require('../models/User');
const MaintenanceRun = require('../models/MaintenanceRun');
const { clearAllFeedCaches } = require('./feedService');
const { clearGrowthStatsCache } = require('./publicStats');
const { clearPopularSearchesCache } = require('./popularSearches');
const { clearGifCache } = require('./gif');
const { clearSiteConfigCache } = require('./siteConfig');
const logger = require('./logger');

const RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAINTENANCE_CRON = '17 3 * * *';

const TASKS = {
  chats: async (cutoff) => {
    const [direct, group] = await Promise.all([
      Message.deleteMany({ createdAt: { $lt: cutoff } }),
      GroupMessage.deleteMany({ createdAt: { $lt: cutoff } })
    ]);
    return { directMessages: direct.deletedCount, groupMessages: group.deletedCount };
  },
  notifications: async (cutoff) => {
    const result = await Notification.deleteMany({ createdAt: { $lt: cutoff } });
    return { notifications: result.deletedCount };
  },
  'search-history': async (cutoff) => {
    const result = await User.updateMany(
      { 'searchHistory.searchedAt': { $lt: cutoff } },
      { $pull: { searchHistory: { searchedAt: { $lt: cutoff } } } }
    );
    return { usersUpdated: result.modifiedCount };
  },
  'recent-views': async (cutoff) => {
    const result = await User.updateMany(
      { 'recentViews.viewedAt': { $lt: cutoff } },
      { $pull: { recentViews: { viewedAt: { $lt: cutoff } } } }
    );
    return { usersUpdated: result.modifiedCount };
  },
  'search-events': async (cutoff) => {
    const result = await SearchEvent.deleteMany({ createdAt: { $lt: cutoff } });
    return { searchEvents: result.deletedCount };
  },
  caches: async () => ({
    feed: clearAllFeedCaches(),
    growthStats: clearGrowthStatsCache(),
    popularSearches: clearPopularSearchesCache(),
    gifs: clearGifCache(),
    siteConfig: clearSiteConfigCache()
  })
};

const ALL_TASKS = Object.keys(TASKS);
const TASK_LABELS = {
  chats: 'Chats older than 30 days',
  notifications: 'Notifications older than 30 days',
  'search-history': 'Personal search history older than 30 days',
  'recent-views': 'Recent-view history older than 30 days',
  'search-events': 'Search trend events older than 30 days',
  caches: 'In-memory caches'
};

async function runMaintenance({ task, triggeredBy = null, scheduled = false, now = new Date() }) {
  if (task !== 'all' && !Object.hasOwn(TASKS, task)) throw new Error('Unknown maintenance task.');
  const tasks = task === 'all' ? ALL_TASKS : [task];
  const startedAt = new Date(now);
  const cutoff = new Date(startedAt.getTime() - RETENTION_DAYS * DAY_MS);
  const results = {};
  let failedTasks = 0;

  for (const name of tasks) {
    try {
      results[name] = { ok: true, cutoff, ...await TASKS[name](cutoff) };
    } catch (error) {
      failedTasks += 1;
      results[name] = { ok: false, error: error.message };
      logger.error(`Maintenance task "${name}" failed`, error);
    }
  }

  const finishedAt = new Date();
  const status = failedTasks === 0 ? 'success' : failedTasks === tasks.length ? 'failed' : 'partial';
  const run = await MaintenanceRun.create({
    task,
    status,
    triggeredBy,
    scheduled,
    results,
    startedAt,
    finishedAt
  });
  if (status === 'success') logger.info(`Maintenance run "${task}" completed.`, { runId: String(run._id), scheduled, results });
  else logger.warn(`Maintenance run "${task}" completed with errors.`, { runId: String(run._id), scheduled, results });
  return run;
}

let maintenanceTask = null;

function startMaintenanceWorker() {
  if (maintenanceTask) return maintenanceTask;
  const timezone = process.env.TZ || 'UTC';
  maintenanceTask = cron.schedule(MAINTENANCE_CRON, () => {
    runMaintenance({ task: 'all', scheduled: true }).catch((error) => logger.error('Scheduled maintenance failed', error));
  }, { timezone });
  logger.info(`Maintenance worker started (daily at 03:17 ${timezone}; data retention ${RETENTION_DAYS} days).`);
  return maintenanceTask;
}

function stopMaintenanceWorker() {
  if (!maintenanceTask) return;
  maintenanceTask.stop();
  maintenanceTask = null;
}

module.exports = { RETENTION_DAYS, MAINTENANCE_CRON, TASKS, TASK_LABELS, runMaintenance, startMaintenanceWorker, stopMaintenanceWorker };
