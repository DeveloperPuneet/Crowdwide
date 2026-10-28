const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');

const root = path.join(__dirname, '..');
const ALLOWED = new Set(['server.js', 'src/services/legacyCleanup.js', 'DEPLOYMENT.md', 'test/widewave-removed.test.js']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out); else out.push(full);
  }
  return out;
}

test('no WideWave code, views, styles, emails or routes are left in the project', () => {
  const textExt = new Set(['.js', '.ejs', '.css', '.md', '.json', '.svg', '.html', '.txt', '.yml', '.example']);
  const offenders = [];
  for (const file of walk(root)) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (ALLOWED.has(rel) || !textExt.has(path.extname(file)) && !file.endsWith('.env.example')) continue;
    if (/widewave|\/ww\/|\bww-[a-z]/i.test(fs.readFileSync(file, 'utf8'))) offenders.push(rel);
    if (/widewave/i.test(rel)) offenders.push(rel);
  }
  assert.deepEqual(offenders, []);
});

test('WideWave pages are no longer routed', () => {
  const router = require('../src/routes/web');
  const paths = router.stack.filter((layer) => layer.route).map((layer) => String(layer.route.path));
  assert.ok(paths.length > 20);
  assert.equal(paths.some((route) => /widewave|^\/ww\//i.test(route)), false);
});

test('the Post model no longer has a widewave field', () => {
  assert.equal(require('../src/models/Post').schema.path('widewave'), undefined);
});

test('start-up cleanup turns WideWave posts into normal posts and drops the old data', async () => {
  const { removeWideWaveData } = require('../src/services/legacyCleanup');
  const calls = [];
  const fakeDb = {
    collection: (name) => ({
      updateMany: async (filter, update) => { calls.push([name, 'updateMany', filter, update]); return { modifiedCount: name === 'posts' ? 7 : 0 }; },
      dropIndex: async (index) => { calls.push([name, 'dropIndex', index]); }
    }),
    listCollections: () => ({ toArray: async () => [{ name: 'widewaves' }] }),
    dropCollection: async (name) => { calls.push(['db', 'dropCollection', name]); }
  };
  const original = Object.getOwnPropertyDescriptor(mongoose.connection, 'db');
  Object.defineProperty(mongoose.connection, 'db', { value: fakeDb, configurable: true, writable: true });
  try {
    const result = await removeWideWaveData();
    assert.deepEqual(result, { postsConverted: 7, collectionDropped: true, indexDropped: true });
    assert.deepEqual(calls[0], ['posts', 'updateMany', { widewave: { $exists: true } }, { $unset: { widewave: '' } }]);
    assert.ok(calls.some((call) => call[1] === 'dropCollection' && call[2] === 'widewaves'));
  } finally {
    if (original) Object.defineProperty(mongoose.connection, 'db', original); else delete mongoose.connection.db;
  }
});

test('start-up cleanup is a no-op without a database and never throws', async () => {
  const { removeWideWaveData } = require('../src/services/legacyCleanup');
  const original = Object.getOwnPropertyDescriptor(mongoose.connection, 'db');
  Object.defineProperty(mongoose.connection, 'db', { value: { collection() { throw new Error('boom'); } }, configurable: true, writable: true });
  try {
    await assert.doesNotReject(removeWideWaveData());
  } finally {
    if (original) Object.defineProperty(mongoose.connection, 'db', original); else delete mongoose.connection.db;
  }
});
