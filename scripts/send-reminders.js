// Runs the come-back reminders once, right now.
//
//   npm run reminders:run            send what is due (respects local daytime hours)
//   npm run reminders:run -- --dry   only count who is due, send nothing
//   npm run reminders:run -- --anytime   ignore the local-daytime rule
//
// Reads the same environment variables the app uses (.env is loaded).
require('dotenv').config();
const mongoose = require('mongoose');
const { sendReengagementReminders, backfillLastActive } = require('../src/services/reengagement');

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set.');
  await mongoose.connect(process.env.MONGODB_URI);
  await backfillLastActive();
  const result = await sendReengagementReminders({ dryRun: process.argv.includes('--dry'), ignoreHours: process.argv.includes('--anytime'), limit: 1000 });
  console.log(JSON.stringify(result, null, 2));
  await mongoose.disconnect();
}

main().catch((error) => { console.error(error.message || error); process.exit(1); });
