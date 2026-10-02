const nodemailer = require('nodemailer');
const { mailAllowed } = require('./environment');
const MailComposer = require('nodemailer/lib/mail-composer');
const logger = require('./logger');

// ---------------------------------------------------------------------------
// How mail leaves Crowdwide
//
//  1. Gmail API over HTTPS (default whenever Gmail OAuth credentials exist).
//     Uses port 443 only, so it keeps working on hosts that block outbound
//     SMTP (Render's free tier, many VPS/PaaS providers, some ISPs). This is
//     the most common reason "I added my Gmail credentials but nothing
//     arrives": the old SMTP connection was silently dropped by the host and
//     each attempt hung until nodemailer's 2-minute connection timeout.
//  2. Plain SMTP (MAIL_HOST / MAIL_USER / MAIL_PASS), or Gmail over SMTP
//     when MAIL_TRANSPORT=smtp.
//
// Whatever the transport, sending is best-effort with a hard timeout: a slow
// or broken mail provider must never make sign-in, sign-up, 2FA or password
// reset slow or fail. Failures are logged with an actionable hint instead.
// ---------------------------------------------------------------------------

const MAIL_TIMEOUT_MS = Number(process.env.MAIL_TIMEOUT_MS) || 15000;
const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const env = (name) => String(process.env[name] || '').trim();

function gmailCredentialsPresent() {
  return Boolean(env('GMAIL_USER') && env('GOOGLE_CLIENT_ID') && env('GOOGLE_CLIENT_SECRET') && env('GOOGLE_REFRESH_TOKEN'));
}

// MAIL_PROVIDER=gmail is honoured, but so is simply having the Gmail
// credentials filled in - forgetting MAIL_PROVIDER used to mean every email
// was silently dropped into the server log instead of being sent.
function provider() {
  const explicit = env('MAIL_PROVIDER').toLowerCase();
  if (explicit === 'gmail') return 'gmail';
  if (explicit) return 'smtp';
  return gmailCredentialsPresent() ? 'gmail' : 'smtp';
}

function usesGmailApi() {
  return provider() === 'gmail' && env('MAIL_TRANSPORT').toLowerCase() !== 'smtp';
}

function fromAddress() {
  return env('MAIL_FROM') || env('GMAIL_USER') || 'Crowdwide <hello@crowdwide.com>';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function safeEmailUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch (error) {
    return '';
  }
}

function brandedEmail({ heading, message, preheader, code, actionUrl, actionLabel }) {
  const safeActionUrl = safeEmailUrl(actionUrl);
  const safeMessage = escapeHtml(message).replace(/\r?\n/g, '<br>');
  const action = safeActionUrl && actionLabel
    ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0 18px;"><tr><td bgcolor="#ff9850" style="border-radius:8px;"><a href="${escapeHtml(safeActionUrl)}" style="display:inline-block;padding:14px 22px;color:#111426;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;text-decoration:none;border-radius:8px;">${escapeHtml(actionLabel)}</a></td></tr></table><p style="margin:0;color:#70758a;font-family:Arial,sans-serif;font-size:12px;line-height:1.6;">If the button does not work, open this link:<br><a href="${escapeHtml(safeActionUrl)}" style="color:#d8732e;word-break:break-all;">${escapeHtml(safeActionUrl)}</a></p>`
    : '';
  const codeBlock = code !== undefined
    ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0;"><tr><td bgcolor="#fff3e8" style="padding:16px 24px;border:1px solid #ffd6b3;border-radius:10px;color:#a34d13;font-family:Arial,sans-serif;font-size:28px;font-weight:bold;letter-spacing:6px;text-align:center;">${escapeHtml(code)}</td></tr></table>`
    : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(heading)}</title></head><body style="margin:0;padding:0;background-color:#f2f4f7;color:#25283a;font-family:Arial,Helvetica,sans-serif;"><span style="display:none!important;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden;color:transparent;">${escapeHtml(preheader || heading)}</span><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f2f4f7" style="width:100%;background-color:#f2f4f7;"><tr><td align="center" style="padding:32px 14px;"><table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;border-collapse:separate;border-spacing:0;"><tr><td bgcolor="#111426" style="padding:26px 32px;border-radius:14px 14px 0 0;background-color:#111426;"><div style="color:#ffffff;font-family:Arial,sans-serif;font-size:22px;font-weight:bold;">Crowdwide<span style="color:#ff9850;">.</span></div><div style="margin-top:5px;color:#aeb2c8;font-family:Arial,sans-serif;font-size:12px;">A fair chance at discovery</div></td></tr><tr><td bgcolor="#ffffff" style="padding:34px 32px;background-color:#ffffff;border-left:1px solid #e4e6ed;border-right:1px solid #e4e6ed;"><div style="display:inline-block;padding:6px 9px;border-radius:999px;background-color:#fff3e8;color:#b75e1c;font-family:Arial,sans-serif;font-size:10px;font-weight:bold;letter-spacing:1px;">ACCOUNT SECURITY</div><h1 style="margin:18px 0 12px;color:#171a2b;font-family:Arial,sans-serif;font-size:25px;line-height:1.25;">${escapeHtml(heading)}</h1><p style="margin:0;color:#555a6d;font-family:Arial,sans-serif;font-size:15px;line-height:1.7;">${safeMessage}</p>${codeBlock}${action}</td></tr><tr><td bgcolor="#f8f9fb" style="padding:18px 32px;border:1px solid #e4e6ed;border-top:0;border-radius:0 0 14px 14px;background-color:#f8f9fb;color:#85899a;font-family:Arial,sans-serif;font-size:11px;line-height:1.6;">This message was sent by Crowdwide to help keep your account secure.<br>If you did not request this, you can ignore this email.<br><span style="color:#b0b3bf;">Crowdwide · curiosity brings us together</span></td></tr></table></td></tr></table></body></html>`;
}

function getSmtpTransporter() {
  const timeouts = { connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 12000 };
  if (provider() === 'gmail') {
    if (!gmailCredentialsPresent()) return null;
    return nodemailer.createTransport({
      service: 'gmail',
      ...timeouts,
      auth: {
        type: 'OAuth2',
        user: env('GMAIL_USER'),
        clientId: env('GOOGLE_CLIENT_ID'),
        clientSecret: env('GOOGLE_CLIENT_SECRET'),
        refreshToken: env('GOOGLE_REFRESH_TOKEN')
      }
    });
  }

  if (!process.env.MAIL_HOST || !process.env.MAIL_USER || !process.env.MAIL_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.MAIL_HOST,
    port: Number(process.env.MAIL_PORT || 587),
    secure: Number(process.env.MAIL_PORT) === 465,
    ...timeouts,
    auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
  });
}

function mailConfigured() {
  return usesGmailApi() ? gmailCredentialsPresent() : Boolean(getSmtpTransporter());
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${ms}ms`), { code: 'ETIMEDOUT' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function fetchJson(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAIL_TIMEOUT_MS);
  try {
    const response = await globalThis.fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    if (error.name === 'AbortError') throw Object.assign(new Error(`Request to ${new URL(url).host} timed out`), { code: 'ETIMEDOUT' });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Turns the raw failure into something a person setting this up can act on.
function explainMailError(error) {
  const text = `${error?.code || ''} ${error?.message || ''} ${error?.googleError || ''}`.toLowerCase();
  if (text.includes('invalid_grant')) return 'The Google refresh token was rejected (expired or revoked). If your OAuth consent screen is in "Testing" mode, refresh tokens expire after 7 days - switch the app to "In production" and generate a new GOOGLE_REFRESH_TOKEN.';
  if (text.includes('invalid_client') || text.includes('unauthorized_client')) return 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET do not match the client that issued the refresh token.';
  if (text.includes('accessnotconfigured') || text.includes('has not been used') || text.includes('is disabled')) return 'The Gmail API is not enabled for this Google Cloud project. Enable "Gmail API" in APIs & Services > Library.';
  if (text.includes('insufficient') || text.includes('scope')) return 'The refresh token was not granted permission to send mail. Re-authorize with the scope https://www.googleapis.com/auth/gmail.send (or https://mail.google.com/).';
  if (text.includes('etimedout') || text.includes('econnrefused') || text.includes('esocket') || text.includes('econnreset') || text.includes('timed out')) return 'Could not reach the mail server in time. If you are using SMTP, your host may block outbound SMTP ports - use the Gmail API transport (leave MAIL_TRANSPORT unset) or an HTTPS mail API.';
  if (text.includes('eauth') || text.includes('invalid login') || text.includes('535')) return 'The SMTP username/password (or app password) was rejected.';
  return 'See the error above.';
}

let cachedAccessToken = null;

async function getGmailAccessToken({ force = false } = {}) {
  if (!force && cachedAccessToken && cachedAccessToken.expiresAt - 60000 > Date.now()) return cachedAccessToken.value;
  const { ok, data } = await fetchJson(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env('GOOGLE_CLIENT_ID'),
      client_secret: env('GOOGLE_CLIENT_SECRET'),
      refresh_token: env('GOOGLE_REFRESH_TOKEN'),
      grant_type: 'refresh_token'
    })
  });
  if (!ok || !data.access_token) {
    throw Object.assign(new Error(`Google token request failed: ${data.error_description || data.error || 'unknown error'}`), { googleError: data.error || '' });
  }
  cachedAccessToken = { value: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return cachedAccessToken.value;
}

function buildRawMessage(mail) {
  return new Promise((resolve, reject) => {
    new MailComposer(mail).compile().build((error, message) => (error ? reject(error) : resolve(message)));
  });
}

async function sendViaGmailApi(mail) {
  const raw = (await buildRawMessage(mail)).toString('base64url');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const accessToken = await getGmailAccessToken({ force: attempt > 0 });
    const { ok, status, data } = await fetchJson(GMAIL_SEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw })
    });
    if (ok) return data;
    if (status === 401 && attempt === 0) continue; // cached token went stale - fetch a fresh one once
    const detail = data?.error?.message || data?.error_description || `HTTP ${status}`;
    throw Object.assign(new Error(`Gmail API send failed: ${detail}`), { googleError: `${data?.error?.status || ''} ${data?.error?.errors?.[0]?.reason || ''}` });
  }
  return null;
}

async function sendViaSmtp(mail) {
  const transporter = getSmtpTransporter();
  return withTimeout(transporter.sendMail(mail), MAIL_TIMEOUT_MS, 'SMTP send');
}

// Email is a best-effort side effect of these auth actions, never a
// precondition for them: a mail-provider hiccup (timeout, expired OAuth
// token, blocked SMTP port, rate limit) must never make login,
// registration, 2FA, or password reset fail or hang just because the
// notification email didn't go out. deliver() swallows send failures
// (logging them with a hint) instead of throwing, and callers in the request
// path do not await it.
async function deliver(mail, previewLabel) {
  if (!mailAllowed(mail.to)) {
    logger.warn(`Staging: email to ${mail.to} skipped (not in STAGING_MAIL_ALLOWLIST). ${previewLabel}`);
    return false;
  }
  if (!mailConfigured()) {
    logger.warn(`Mail is not configured - nothing was emailed. ${previewLabel}`);
    return false;
  }
  try {
    if (usesGmailApi()) await sendViaGmailApi(mail);
    else await sendViaSmtp(mail);
    return true;
  } catch (error) {
    logger.error(`Failed to send mail (${mail.subject}) to ${mail.to}`, { error, hint: explainMailError(error) });
    return false;
  }
}

// Checks the credentials without sending anything. Used at boot and by
// `npm run mail:test`.
async function verifyMailConfig() {
  const name = usesGmailApi() ? 'Gmail API (HTTPS)' : provider() === 'gmail' ? 'Gmail SMTP' : 'SMTP';
  if (!mailConfigured()) {
    return { ok: false, transport: name, detail: 'No mail credentials found. Set GMAIL_USER, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN (Gmail), or MAIL_HOST, MAIL_USER and MAIL_PASS (SMTP).' };
  }
  try {
    if (usesGmailApi()) await getGmailAccessToken({ force: true });
    else await withTimeout(getSmtpTransporter().verify(), MAIL_TIMEOUT_MS, 'SMTP verify');
    return { ok: true, transport: name, detail: 'Credentials accepted.' };
  } catch (error) {
    return { ok: false, transport: name, detail: `${error.message} - ${explainMailError(error)}` };
  }
}

// Sends one real message and reports the outcome, for `npm run mail:test`.
async function sendTestEmail(to) {
  const mail = {
    from: fromAddress(),
    to,
    subject: 'Crowdwide test email',
    text: 'If you can read this, Crowdwide can send email.',
    html: brandedEmail({ heading: 'Your email is connected', message: 'If you can read this, Crowdwide can send email.', preheader: 'Crowdwide mail setup test' })
  };
  try {
    if (usesGmailApi()) await sendViaGmailApi(mail);
    else await sendViaSmtp(mail);
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: `${error.message} - ${explainMailError(error)}` };
  }
}

async function sendVerificationCode(user, code) {
  const bodyText = 'Use this verification code to finish setting up your Crowdwide account. It expires in 15 minutes.';
  const message = {
    from: fromAddress(),
    to: user.email,
    subject: 'Your Crowdwide verification code',
    text: `${bodyText}\n\nYour verification code is ${code}`,
    html: brandedEmail({ heading: 'Welcome to Crowdwide', message: bodyText, preheader: 'Your email verification code', code })
  };
  await deliver(message, `Verification code for ${user.email}: ${code}`);
}

async function sendSecurityAlert(user, { subject, heading, message }) {
  const mail = {
    from: fromAddress(),
    to: user.email,
    subject,
    text: message,
    html: brandedEmail({ heading, message, preheader: subject })
  };
  await deliver(mail, `${subject} for ${user.email}: ${message}`);
}

async function sendNewDeviceAlert(user, details) {
  return sendSecurityAlert(user, {
    subject: 'New Crowdwide sign-in',
    heading: 'New Crowdwide sign-in',
    message: `A new sign-in to your Crowdwide account was recorded from ${details.ipAddress || 'an unknown IP'} using ${details.userAgent || 'an unknown browser'}. If this was not you, change your password immediately.`
  });
}

async function sendPasswordResetLink(user, resetUrl) {
  const message = 'We received a request to reset your Crowdwide password. This link expires in 30 minutes. If you did not request this, you can safely ignore this email and your password will stay the same.';
  const mail = {
    from: fromAddress(),
    to: user.email,
    subject: 'Reset your Crowdwide password',
    text: `${message}\n\nReset password: ${resetUrl}`,
    html: brandedEmail({ heading: 'Reset your password', message, preheader: 'Your Crowdwide password reset link', actionUrl: resetUrl, actionLabel: 'Reset password' })
  };
  await deliver(mail, `Password reset email for ${user.email} (reset link omitted)`);
}

module.exports = {
  sendVerificationCode,
  sendNewDeviceAlert,
  sendSecurityAlert,
  sendPasswordResetLink,
  verifyMailConfig,
  sendTestEmail,
  explainMailError
};
