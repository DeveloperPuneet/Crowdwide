require('dotenv').config();
const logger = require('./src/services/logger');

const createApp = require('./src/app');
const connectDatabase = require('./src/config/database');
const { startPublicationWorker } = require('./src/services/publicationWorker');
const { verifyMailConfig } = require('./src/services/mailer');
const { startKeepAlive, stopKeepAlive } = require('./src/services/keepAlive');

const port = process.env.PORT || 3000;
const app = createApp({ port });

process.on('unhandledRejection', (reason) => logger.error('Unhandled promise rejection', reason instanceof Error ? reason : { reason: String(reason) }));

async function start() {
  await connectDatabase();
  startPublicationWorker();
  const server = app.listen(port, () => logger.info(`Crowdwide is live at http://localhost:${port}`));

  // Free-tier hosts put idle services to sleep; a node-cron job pings our own
  // /health URL every few minutes so the instance stays warm.
  startKeepAlive();
  const shutdown = () => { stopKeepAlive(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  // Tell the operator up front whether email will actually work, instead of
  // leaving them to discover it when the first verification code never
  // arrives. Runs in the background so it can never delay startup.
  verifyMailConfig().then((result) => {
    if (result.ok) logger.info(`Mail is ready via ${result.transport}.`);
    else logger.warn(`Mail is NOT working (${result.transport}): ${result.detail}`);
  }).catch((error) => logger.warn('Could not check mail configuration', error));
}

start().catch((error) => {
  logger.error('Unable to start Crowdwide', error);
  process.exit(1);
});
