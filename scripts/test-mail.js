// Checks your mail credentials and sends one real test email, printing the
// exact reason if it fails.
//
//   npm run mail:test -- you@example.com
//
// Reads the same environment variables the app uses (.env is loaded).
require('dotenv').config();
const { verifyMailConfig, sendTestEmail } = require('../src/services/mailer');

async function main() {
  const to = process.argv[2];
  console.log('Checking mail configuration...');
  const check = await verifyMailConfig();
  console.log(`Transport: ${check.transport}`);
  console.log(check.ok ? 'Credentials: OK' : `Credentials: FAILED\n  ${check.detail}`);
  if (!check.ok) process.exit(1);

  if (!to) {
    console.log('\nCredentials work. Pass an address to send a real test email:\n  npm run mail:test -- you@example.com');
    return;
  }
  console.log(`\nSending a test email to ${to}...`);
  const result = await sendTestEmail(to);
  if (result.ok) console.log('Sent. Check the inbox (and spam folder).');
  else {
    console.log(`FAILED\n  ${result.detail}`);
    process.exit(1);
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
