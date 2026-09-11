const nodemailer = require('nodemailer');

function getTransporter() {
  if (process.env.MAIL_PROVIDER === 'gmail') {
    if (!process.env.GMAIL_USER || !process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REFRESH_TOKEN) return null;
    return nodemailer.createTransport({
      service: 'gmail',
      auth: {
        type: 'OAuth2',
        user: process.env.GMAIL_USER,
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        refreshToken: process.env.GOOGLE_REFRESH_TOKEN
      }
    });
  }

  if (!process.env.MAIL_HOST || !process.env.MAIL_USER || !process.env.MAIL_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.MAIL_HOST,
    port: Number(process.env.MAIL_PORT || 587),
    secure: Number(process.env.MAIL_PORT) === 465,
    auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
  });
}

async function sendVerificationCode(user, code) {
  const transporter = getTransporter();
  const message = {
    from: process.env.MAIL_FROM || process.env.GMAIL_USER || 'Crowdwide <hello@crowdwide.com>',
    to: user.email,
    subject: 'Your Crowdwide verification code',
    text: `Your Crowdwide verification code is ${code}. It expires in 15 minutes.`,
    html: `<h2>Welcome to Crowdwide</h2><p>Your verification code is <strong>${code}</strong>.</p><p>This code expires in 15 minutes.</p>`
  };

  if (!transporter) {
    console.log(`[Crowdwide mail preview] Verification code for ${user.email}: ${code}`);
    return;
  }
  await transporter.sendMail(message);
}

module.exports = { sendVerificationCode };
