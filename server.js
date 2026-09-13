require('dotenv').config();

const createApp = require('./src/app');
const connectDatabase = require('./src/config/database');
const { startPublicationWorker } = require('./src/services/publicationWorker');

const port = process.env.PORT || 3000;
const app = createApp({ port });

async function start() {
  await connectDatabase();
  startPublicationWorker();
  app.listen(port, () => console.log(`Crowdwide is live at http://localhost:${port}`));
}

start().catch((error) => {
  console.error('Unable to start Crowdwide:', error.message);
  process.exit(1);
});
