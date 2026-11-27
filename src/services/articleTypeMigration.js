const mongoose = require('mongoose');
const Post = require('../models/Post');
const { getWordLimits } = require('./siteConfig');
const countWords = require('../utils/wordCount');
const logger = require('./logger');

const BATCH_SIZE = 500;

async function convertShortPublishedArticles() {
  const db = mongoose.connection?.db;
  if (!db) return { skipped: true, converted: 0 };

  const postWordLimit = (await getWordLimits()).post;
  const migrationId = `short-articles-to-posts-under-${postWordLimit}-v1`;
  const migrations = db.collection('app_migrations');
  if (await migrations.findOne({ _id: migrationId })) {
    return { skipped: true, converted: 0, postWordLimit };
  }

  const cursor = Post.find({ type: 'article', status: 'published' })
    .select('_id body')
    .lean()
    .cursor();
  let operations = [];
  let converted = 0;

  const flush = async () => {
    if (!operations.length) return;
    const result = await Post.bulkWrite(operations, { ordered: false, timestamps: false });
    converted += result.modifiedCount || 0;
    operations = [];
  };

  for await (const post of cursor) {
    if (countWords(post.body) >= postWordLimit) continue;
    operations.push({
      updateOne: {
        filter: { _id: post._id, type: 'article', status: 'published' },
        update: { $set: { type: 'post' } }
      }
    });
    if (operations.length >= BATCH_SIZE) await flush();
  }
  await flush();

  await migrations.updateOne(
    { _id: migrationId },
    { $setOnInsert: { completedAt: new Date(), postWordLimit } },
    { upsert: true }
  );
  if (converted) logger.info(`Converted ${converted} published short articles to posts.`, { postWordLimit });
  return { skipped: false, converted, postWordLimit };
}

module.exports = { convertShortPublishedArticles };
