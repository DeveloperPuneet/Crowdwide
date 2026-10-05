const test = require('node:test');
const assert = require('node:assert/strict');
const Message = require('../src/models/Message');
const GroupMessage = require('../src/models/GroupMessage');
const Notification = require('../src/models/Notification');
const SearchEvent = require('../src/models/SearchEvent');
const User = require('../src/models/User');
const MaintenanceRun = require('../src/models/MaintenanceRun');
const { RETENTION_DAYS, TASKS, runMaintenance } = require('../src/services/maintenance');

const fixedNow = new Date('2026-04-20T12:00:00Z');
const expectedCutoff = new Date(fixedNow.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

test('maintenance retention window is 30 days', () => {
  assert.equal(RETENTION_DAYS, 30);
});

test('chat cleanup removes only messages older than the 30-day cutoff', async (t) => {
  const filters = [];
  t.mock.method(Message, 'deleteMany', async (filter) => {
    filters.push(filter);
    return { deletedCount: 3 };
  });
  t.mock.method(GroupMessage, 'deleteMany', async (filter) => {
    filters.push(filter);
    return { deletedCount: 2 };
  });

  const result = await TASKS.chats(expectedCutoff);
  assert.deepEqual(result, { directMessages: 3, groupMessages: 2 });
  assert.deepEqual(filters, [
    { createdAt: { $lt: expectedCutoff } },
    { createdAt: { $lt: expectedCutoff } }
  ]);
});

test('history cleanup pulls expired entries from embedded user histories', async (t) => {
  const filters = [];
  const updates = [];
  t.mock.method(User, 'updateMany', async (filter, update) => {
    filters.push(filter);
    updates.push(update);
    return { modifiedCount: 4 };
  });

  assert.deepEqual(await TASKS['search-history'](expectedCutoff), { usersUpdated: 4 });
  assert.deepEqual(await TASKS['recent-views'](expectedCutoff), { usersUpdated: 4 });
  assert.deepEqual(filters, [
    { 'searchHistory.searchedAt': { $lt: expectedCutoff } },
    { 'recentViews.viewedAt': { $lt: expectedCutoff } }
  ]);
  assert.deepEqual(updates, [
    { $pull: { searchHistory: { searchedAt: { $lt: expectedCutoff } } } },
    { $pull: { recentViews: { viewedAt: { $lt: expectedCutoff } } } }
  ]);
});

test('manual maintenance records its cutoff, status and outcome', async (t) => {
  let savedRun;
  t.mock.method(Notification, 'deleteMany', async (filter) => {
    assert.deepEqual(filter, { createdAt: { $lt: expectedCutoff } });
    return { deletedCount: 7 };
  });
  t.mock.method(MaintenanceRun, 'create', async (data) => {
    savedRun = data;
    return { _id: 'run-1', ...data };
  });

  const run = await runMaintenance({ task: 'notifications', triggeredBy: 'admin-1', now: fixedNow });
  assert.equal(run._id, 'run-1');
  assert.equal(savedRun.status, 'success');
  assert.equal(savedRun.triggeredBy, 'admin-1');
  assert.equal(savedRun.results.notifications.ok, true);
  assert.equal(savedRun.results.notifications.notifications, 7);
  assert.equal(savedRun.results.notifications.cutoff.toISOString(), expectedCutoff.toISOString());
  assert.ok(savedRun.finishedAt instanceof Date);
});

test('maintenance rejects unknown task names instead of silently succeeding', async () => {
  await assert.rejects(runMaintenance({ task: 'unknown', now: fixedNow }), /Unknown maintenance task/);
});

test('notifications and search events have matching 30-day TTL indexes', () => {
  for (const Model of [Notification, SearchEvent, Message, GroupMessage]) {
    const ttlIndexes = Model.schema.indexes()
      .filter(([, options]) => Number.isFinite(options.expireAfterSeconds))
      .map(([, options]) => options.expireAfterSeconds);
    assert.ok(ttlIndexes.includes(30 * 24 * 60 * 60), `${Model.modelName} should have a 30-day TTL index`);
  }
});
