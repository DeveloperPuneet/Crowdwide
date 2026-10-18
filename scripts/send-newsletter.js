// Sends the weekly newsletter right now to everyone who is opted in and has not
// had one in the last six days, ignoring the Sunday 10:30 window. Useful after
// a missed Sunday.
//
//   npm run newsletter:send
//
// Reads the same environment variables the app uses (.env is loaded).
require('dotenv').config();
const mongoose = require('mongoose');
const { sendWeeklyNewsletters } = require('../src/services/newsletterWorker');

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set.');
  await mongoose.connect(process.env.MONGODB_URI);
  const result = await sendWeeklyNewsletters({ force: true });
  console.log(`Eligible: ${result.eligible}, sent: ${result.sent}, skipped (nothing new to recommend): ${result.skippedNoPosts}`);
  await mongoose.disconnect();
}

main().catch((error) => { console.error(error.message || error); process.exit(1); });
