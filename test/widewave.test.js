const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { validateWideWaveName, normalizeWideWaveName } = require('../src/utils/widewaveName');
const WideWave = require('../src/models/WideWave');
const Post = require('../src/models/Post');
const svc = require('../src/services/widewaves');

test('names are normalised and validated as ww/<name>', () => {
  assert.equal(normalizeWideWaveName(' WW/Poetry '), 'poetry');
  assert.equal(validateWideWaveName('ww/Art_2').name, 'art_2');
  for (const bad of ['ab', 'a b', 'ww/', 'has-dash', '12345', '_x_name', 'admin', 'leaderboard', 'x'.repeat(31)]) assert.equal(validateWideWaveName(bad).ok, false, bad);
});

test('creating validates description, hashtags and the daily limit and reports duplicate names', async (t) => {
  await assert.rejects(svc.createWideWave({ userId: 'u', name: 'ww/ab', description: 'Long enough description', hashtags: 'a1' }), svc.WideWaveError);
  await assert.rejects(svc.createWideWave({ userId: 'u', name: 'poetry', description: 'short', hashtags: 'poetry' }), /description/);
  await assert.rejects(svc.createWideWave({ userId: 'u', name: 'poetry', description: 'A place for verse and poems', hashtags: '' }), /hashtag/);
  t.mock.method(WideWave, 'countDocuments', async () => svc.MAX_CREATED_PER_DAY);
  await assert.rejects(svc.createWideWave({ userId: 'u', name: 'poetry', description: 'A place for verse and poems', hashtags: 'poetry' }), /a day/);
  t.mock.method(WideWave, 'countDocuments', async () => 0);
  t.mock.method(WideWave, 'create', async () => { const e = new Error('dup'); e.code = 11000; throw e; });
  await assert.rejects(svc.createWideWave({ userId: 'u', name: 'poetry', description: 'A place for verse and poems', hashtags: 'poetry' }), /already taken/);
  t.mock.method(WideWave, 'create', async (doc) => doc);
  const wave = await svc.createWideWave({ userId: 'u', name: 'WW/Poetry', description: 'A place for verse and poems', hashtags: '#Poetry, verse poetry' });
  assert.equal(wave.name, 'poetry');
  assert.deepEqual(wave.hashtags, ['poetry', 'verse']);
});

test('only the creator can edit (description and hashtags only) or delete', async (t) => {
  const wave = { _id: 'w1', name: 'poetry', creator: 'owner', status: 'active', description: 'old description here', hashtags: ['a1'], save: async () => {} };
  await assert.rejects(svc.updateWideWave({ wave, userId: 'other', description: 'a new description!!', hashtags: 'x1' }), /creator/);
  await svc.updateWideWave({ wave, userId: 'owner', description: 'a new description!!', hashtags: 'verse, rhyme' });
  assert.equal(wave.name, 'poetry');
  assert.deepEqual(wave.hashtags, ['verse', 'rhyme']);
  await assert.rejects(svc.deleteWideWave({ wave, actorId: 'other' }), /creator/);
});

test('deleting a WideWave keeps its posts as normal posts', async (t) => {
  let update; let deleted;
  t.mock.method(Post, 'updateMany', async (filter, change) => { update = { filter, change }; return { modifiedCount: 4 }; });
  t.mock.method(WideWave, 'deleteOne', async (filter) => { deleted = filter; });
  const result = await svc.deleteWideWave({ wave: { _id: 'w1', creator: 'owner' }, actorId: 'owner' });
  assert.deepEqual(update.filter, { widewave: 'w1' });
  assert.deepEqual(update.change, { $set: { widewave: null } });
  assert.deepEqual(deleted, { _id: 'w1' });
  assert.equal(result.moved, 4);
});

test('a moderator removal keeps the record so the name stays blocked', async (t) => {
  t.mock.method(Post, 'updateMany', async () => ({ modifiedCount: 2 }));
  let saved = false;
  const wave = { _id: 'w1', creator: 'owner', status: 'active', save: async () => { saved = true; } };
  await svc.deleteWideWave({ wave, actorId: 'mod', staff: true, reason: 'spam' });
  assert.equal(wave.status, 'removed');
  assert.equal(wave.removedReason, 'spam');
  assert.ok(saved);
});

test('interest overlap and leaderboard periods', () => {
  assert.equal(svc.interestOverlap(new Map([['art', 2], ['poetry', 1]]), ['Art', 'x']), 2);
  assert.equal(svc.periodStart('all'), null);
  assert.ok(svc.periodStart('week', 1_000_000_000_000) < 1_000_000_000_000);
});

test('composer, routes and post card are wired for WideWaves', () => {
  const routes = fs.readFileSync('src/routes/web.js', 'utf8');
  assert.match(routes, /router\.get\('\/ww\/:name'/);
  assert.match(routes, /router\.get\('\/widewaves\/leaderboard'/);
  assert.match(fs.readFileSync('src/views/pages/dashboard.ejs', 'utf8'), /data-ww-open/);
  assert.match(fs.readFileSync('src/views/partials/post-card.ejs', 'utf8'), /ww-chip/);
  assert.match(fs.readFileSync('src/controllers/webController.js', 'utf8'), /widewave: waveTarget\?\._id \|\| null/);
});
