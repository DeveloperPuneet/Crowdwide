require('dotenv').config();
const logger = require('./src/services/logger');

const createApp = require('./src/app');
const connectDatabase = require('./src/config/database');
const { startPublicationWorker } = require('./src/services/publicationWorker');

const port = process.env.PORT || 3000;
const app = createApp({ port });

async function start() {
  await connectDatabase();
  startPublicationWorker();
  app.listen(port, () => logger.info(`Crowdwide is live at http://localhost:${port}`));
}

start().catch((error) => {
  logger.error('Unable to start Crowdwide', error);
  process.exit(1);
});
