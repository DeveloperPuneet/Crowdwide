const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Post = require('../src/models/Post');
const SiteSetting = require('../src/models/SiteSetting');
const { clearSiteConfigCache } = require('../src/services/siteConfig');
const { convertShortPublishedArticles } = require('../src/services/articleTypeMigration');

function withDatabase(t, db) {
  const original = Object.getOwnPropertyDescriptor(mongoose.connection, 'db');
  Object.defineProperty(mongoose.connection, 'db', { value: db, configurable: true, writable: true });
  t.after(() => {
    if (original) Object.defineProperty(mongoose.connection, 'db', original);
    else delete mongoose.connection.db;
  });
}

test('startup migration converts only published articles shorter than the post limit', async (t) => {
  t.mock.method(SiteSetting, 'getSingleton', () => Promise.resolve({ postWordLimit: 60, articleWordLimit: 300 }));
  clearSiteConfigCache();
  t.after(clearSiteConfigCache);

  const candidates = [
    { _id: 'short', body: Array(59).fill('word').join(' ') },
    { _id: 'boundary', body: Array(60).fill('word').join(' ') }
  ];
  const operations = [];
  const markerWrites = [];
  withDatabase(t, {
    collection(name) {
      assert.equal(name, 'app_migrations');
      return {
        findOne: async () => null,
        updateOne: async (...args) => markerWrites.push(args)
      };
    }
  });
  t.mock.method(Post, 'find', (filter) => {
    assert.deepEqual(filter, { type: 'article', status: 'published' });
    return {
      select() { return this; },
      lean() { return this; },
      async *cursor() { yield* candidates; }
    };
  });
  t.mock.method(Post, 'bulkWrite', async (batch, options) => {
    operations.push(...batch);
    assert.deepEqual(options, { ordered: false, timestamps: false });
    return { modifiedCount: batch.length };
  });

  const result = await convertShortPublishedArticles();
  assert.deepEqual(result, { skipped: false, converted: 1, postWordLimit: 60 });
  assert.deepEqual(operations, [{
    updateOne: {
      filter: { _id: 'short', type: 'article', status: 'published' },
      update: { $set: { type: 'post' } }
    }
  }]);
  assert.equal(markerWrites.length, 1);
});

test('startup migration skips a completed threshold version', async (t) => {
  t.mock.method(SiteSetting, 'getSingleton', () => Promise.resolve({ postWordLimit: 60 }));
  clearSiteConfigCache();
  t.after(clearSiteConfigCache);
  withDatabase(t, {
    collection() {
      return { findOne: async () => ({ _id: 'short-articles-to-posts-under-60-v1' }) };
    }
  });
  t.mock.method(Post, 'find', () => { throw new Error('completed migration should not scan posts'); });

  assert.deepEqual(await convertShortPublishedArticles(), { skipped: true, converted: 0, postWordLimit: 60 });
});
