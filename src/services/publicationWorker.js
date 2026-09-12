const Post = require('../models/Post');

async function publishScheduledPosts() {
  const result = await Post.updateMany({ status: 'scheduled', scheduledAt: { $lte: new Date() } }, { $set: { status: 'published' }, $unset: { scheduledAt: 1 } });
  if (result.modifiedCount) console.log(`Published ${result.modifiedCount} scheduled post${result.modifiedCount === 1 ? '' : 's'}.`);
}

function startPublicationWorker() {
  const run = () => publishScheduledPosts().catch((error) => console.error('Scheduled publication failed:', error.message));
  run();
  return setInterval(run, 60 * 1000);
}

module.exports = { publishScheduledPosts, startPublicationWorker };