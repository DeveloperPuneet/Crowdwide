const Post = require('../models/Post');
const logger = require('./logger');

async function publishScheduledPosts() {
  const result = await Post.updateMany({ status: 'scheduled', scheduledAt: { $lte: new Date() } }, { $set: { status: 'published' }, $unset: { scheduledAt: 1 } });
  if (result.modifiedCount) logger.info(`Published ${result.modifiedCount} scheduled post${result.modifiedCount === 1 ? '' : 's'}.`);
}

function startPublicationWorker() {
  const run = () => publishScheduledPosts().catch((error) => logger.error('Scheduled publication failed', error));
  run();
  return setInterval(run, 60 * 1000);
}

module.exports = { publishScheduledPosts, startPublicationWorker };