const nodemailer = require('nodemailer');
const { mailAllowed } = require('./environment');
const MailComposer = require('nodemailer/lib/mail-composer');
const logger = require('./logger');
const { preview } = require('../utils/textPreview');

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
  return env('MAIL_FROM') || env('GMAIL_USER') || 'Crowdwide <crowdwide.support@gmail.com>';
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

const EMAIL_TONES = {
  default: { accent: '#5c63ed', soft: '#f2f3ff', softBorder: '#e0e2ff', pillBg: '#eceeff', pillText: '#4d56d8' },
  warning: { accent: '#e8890c', soft: '#fff6e8', softBorder: '#ffe1b3', pillBg: '#ffecd0', pillText: '#a85d00' },
  success: { accent: '#18a36a', soft: '#eefaf4', softBorder: '#c9ecd9', pillBg: '#d7f4e6', pillText: '#0f7a4f' }
};

// Dark-mode and small-screen rules. Every colour is also set inline so clients
// that strip <style> (or ignore prefers-color-scheme) still show the light layout.
const EMAIL_STYLES = `
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  @media (max-width: 520px) {
    .em-outer { padding: 16px 8px !important; }
    .em-head { padding: 20px 20px !important; }
    .em-pad { padding: 28px 20px 26px !important; }
    .em-h1 { font-size: 24px !important; }
    .em-code { font-size: 28px !important; letter-spacing: 5px !important; }
    .em-btn a { display: block !important; text-align: center !important; }
    .em-btn { width: 100% !important; }
    .em-foot { padding: 18px 20px !important; }
  }
  @media (prefers-color-scheme: dark) {
    .em-body { background-color: #0d0f1e !important; }
    .em-card { background-color: #171a2e !important; border-color: #2a2f4a !important; }
    .em-h { color: #f1f3ff !important; }
    .em-p { color: #c5cae0 !important; }
    .em-muted { color: #9ba2bf !important; }
    .em-strong { color: #e6e9fc !important; }
    .em-soft { background-color: #1f2340 !important; border-color: #323862 !important; }
    .em-line { border-color: #2a2f4a !important; }
    .em-foot { background-color: #12142a !important; border-color: #2a2f4a !important; color: #9ba2bf !important; }
    .em-link { color: #a9aeff !important; }
    .em-accent { color: #a9aeff !important; }
    .em-pill { background-color: #272c55 !important; color: #c3c7ff !important; }
    .em-warn { background-color: #33260f !important; border-color: #e8890c !important; }
    .em-ok { background-color: #0f2b20 !important; border-color: #18a36a !important; }
  }`;

function brandedEmail({ heading, message, preheader, eyebrow = 'ACCOUNT SECURITY', code, codeNote, steps = [], details = [], actionUrl, actionLabel, note, contentHtml = '', greeting, tone = 'default', manageUrl }) {
  const palette = EMAIL_TONES[tone] || EMAIL_TONES.default;
  const toneClass = tone === 'warning' ? ' em-warn' : tone === 'success' ? ' em-ok' : '';
  const safeActionUrl = safeEmailUrl(actionUrl);
  const siteUrl = safeEmailUrl(env('APP_URL') || 'https://www.crowdwide.run.place');
  const safeManageUrl = safeEmailUrl(manageUrl);
  const greetingBlock = greeting ? `<p class="em-h" style="margin:0 0 10px;color:#252b45;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;line-height:1.6;">Hello ${escapeHtml(greeting)},</p>` : '';
  const safeMessage = greetingBlock + String(message || '').split(/\n\s*\n/).map((paragraph) => `<p class="em-p" style="margin:0 0 14px;color:#4b5268;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.75;">${escapeHtml(paragraph).replace(/\r?\n/g, '<br>')}</p>`).join('') + contentHtml;
  const detailRows = details.length
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="em-line" style="margin:22px 0;border-collapse:separate;border-spacing:0;border:1px solid #e4e7f0;border-radius:10px;">${details.map(({ label, value }, index) => `<tr><td class="em-line em-muted" width="34%" valign="top" style="padding:11px 14px;${index ? 'border-top:1px solid #e4e7f0;' : ''}color:#68708a;font-family:Arial,sans-serif;font-size:11px;font-weight:bold;letter-spacing:.6px;text-transform:uppercase;">${escapeHtml(label)}</td><td class="em-line em-strong" valign="top" style="padding:11px 14px;${index ? 'border-top:1px solid #e4e7f0;' : ''}color:#252b45;font-family:Arial,sans-serif;font-size:13px;font-weight:bold;line-height:1.5;overflow-wrap:anywhere;word-break:break-word;">${escapeHtml(value)}</td></tr>`).join('')}</table>`
    : '';
  const stepsBlock = steps.length
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="em-soft" style="margin:22px 0;background-color:#f2f3ff;border:1px solid #e0e2ff;border-radius:10px;"><tr><td class="em-p" style="padding:16px 18px;color:#414966;font-family:Arial,sans-serif;font-size:13px;line-height:1.8;">${steps.map((step, index) => `<div style="padding:3px 0;"><span style="display:inline-block;width:22px;height:22px;margin-right:10px;border-radius:50%;background-color:#5c63ed;color:#ffffff;font-size:12px;font-weight:bold;line-height:22px;text-align:center;">${index + 1}</span>${escapeHtml(step)}</div>`).join('')}</td></tr></table>`
    : '';
  const action = safeActionUrl && actionLabel
    ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" class="em-btn" style="margin:26px 0 16px;"><tr><td bgcolor="#5c63ed" style="border-radius:10px;background-color:#5c63ed;"><a href="${escapeHtml(safeActionUrl)}" style="display:inline-block;padding:15px 26px;color:#ffffff;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;text-decoration:none;border-radius:10px;">${escapeHtml(actionLabel)} &nbsp;›</a></td></tr></table><p class="em-muted" style="margin:0;color:#68708a;font-family:Arial,sans-serif;font-size:12px;line-height:1.65;">Button not working? Paste this link into your browser:<br><a class="em-link" href="${escapeHtml(safeActionUrl)}" style="color:#4d56d8;word-break:break-all;">${escapeHtml(safeActionUrl)}</a></p>`
    : '';
  const codeBlock = code !== undefined
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0;"><tr><td align="center" bgcolor="#f2f3ff" class="em-soft" style="padding:24px 16px;border:1px solid #dfe2ff;border-radius:14px;background-color:#f2f3ff;"><div class="em-muted" style="margin-bottom:10px;color:#626a88;font-family:Arial,sans-serif;font-size:10px;font-weight:bold;letter-spacing:1.6px;">YOUR ONE-TIME CODE</div><div class="em-code em-accent" style="color:#4d56d8;font-family:'SFMono-Regular',Menlo,Consolas,'Courier New',monospace;font-size:34px;font-weight:bold;letter-spacing:8px;">${escapeHtml(code)}</div>${codeNote ? `<div class="em-muted" style="margin-top:10px;color:#737b91;font-family:Arial,sans-serif;font-size:12px;">${escapeHtml(codeNote)}</div>` : ''}</td></tr></table>`
    : '';
  const safeNote = note ? `<div class="em-soft em-p${toneClass}" style="margin-top:24px;padding:14px 16px;border-left:3px solid ${palette.accent};border-radius:0 8px 8px 0;background-color:${palette.soft};color:#4b5268;font-family:Arial,sans-serif;font-size:12px;line-height:1.65;">${escapeHtml(note)}</div>` : '';
  const footerLinks = [
    siteUrl ? `<a class="em-link" href="${escapeHtml(siteUrl)}" style="color:#4d56d8;text-decoration:none;">Visit Crowdwide</a>` : '',
    siteUrl ? `<a class="em-link" href="${escapeHtml(siteUrl.replace(/\/$/, ''))}/privacy" style="color:#4d56d8;text-decoration:none;">Privacy</a>` : '',
    siteUrl ? `<a class="em-link" href="${escapeHtml(siteUrl.replace(/\/$/, ''))}/terms" style="color:#4d56d8;text-decoration:none;">Terms</a>` : '',
    safeManageUrl ? `<a class="em-link" href="${escapeHtml(safeManageUrl)}" style="color:#4d56d8;text-decoration:none;">Email preferences</a>` : '',
    '<a class="em-link" href="mailto:crowdwide.support@gmail.com" style="color:#4d56d8;text-decoration:none;">Contact support</a>'
  ].filter(Boolean).join(' &nbsp;·&nbsp; ');
  const reason = safeManageUrl
    ? 'You are receiving this because of your Crowdwide notification settings.'
    : 'This account message was sent to the email address associated with your Crowdwide account.';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${escapeHtml(heading)} · Crowdwide</title><style>${EMAIL_STYLES}</style></head>
<body class="em-body" style="margin:0;padding:0;background-color:#f0f1f8;color:#252b45;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;">
<span style="display:none!important;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden;color:transparent;mso-hide:all;">${escapeHtml(preheader || heading)}${'&nbsp;&zwnj;'.repeat(24)}</span>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f0f1f8" class="em-body" style="width:100%;background-color:#f0f1f8;"><tr><td align="center" class="em-outer" style="padding:36px 14px;">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;border-collapse:separate;border-spacing:0;">
<tr><td height="6" bgcolor="#5c63ed" style="height:6px;font-size:0;line-height:0;background-color:#5c63ed;border-radius:14px 14px 0 0;">&nbsp;</td></tr>
<tr><td bgcolor="#111426" class="em-head" style="padding:24px 32px;background-color:#111426;">
<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
<td align="center" width="40" height="40" bgcolor="#5c63ed" style="width:40px;height:40px;border-radius:12px;background-color:#5c63ed;color:#ffffff;font-family:Arial,sans-serif;font-size:19px;font-weight:bold;">C</td>
<td style="padding-left:12px;"><div style="color:#ffffff;font-family:Arial,sans-serif;font-size:23px;font-weight:bold;letter-spacing:.2px;">Crowdwide<span style="color:#ff9850;">.</span></div><div style="margin-top:3px;color:#b8bdd3;font-family:Arial,sans-serif;font-size:12px;">A fair chance at discovery</div></td>
</tr></table></td></tr>
<tr><td bgcolor="#ffffff" class="em-card em-pad" style="padding:36px 34px 32px;background-color:#ffffff;border-left:1px solid #e1e4eb;border-right:1px solid #e1e4eb;">
<span class="em-pill" style="display:inline-block;margin-bottom:16px;padding:5px 11px;border-radius:999px;background-color:${palette.pillBg};color:${palette.pillText};font-family:Arial,sans-serif;font-size:10px;font-weight:bold;letter-spacing:1.3px;">${escapeHtml(eyebrow)}</span>
<h1 class="em-h em-h1" style="margin:0 0 16px;color:#202641;font-family:Arial,sans-serif;font-size:28px;line-height:1.25;">${escapeHtml(heading)}</h1>${safeMessage}${stepsBlock}${codeBlock}${detailRows}${action}${safeNote}
</td></tr>
<tr><td bgcolor="#f8f9fd" class="em-foot" style="padding:22px 32px;border:1px solid #e1e4eb;border-top:0;border-radius:0 0 14px 14px;background-color:#f8f9fd;color:#68708a;font-family:Arial,sans-serif;font-size:11px;line-height:1.8;"><strong class="em-strong" style="color:#343c5a;">A little more room for curiosity.</strong><br>${reason}<br>${footerLinks}<br><span style="color:#7d849b;">If you did not request this, you can safely ignore it.</span></td></tr>
</table></td></tr></table></body></html>`;
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
  const bodyText = 'Welcome to Crowdwide. Confirm that this email address belongs to you to finish creating your account.';
  const verifyUrl = `${env('APP_URL') || 'https://www.crowdwide.run.place'}/auth/verify?email=${encodeURIComponent(user.email)}`;
  const message = {
    from: fromAddress(),
    to: user.email,
    subject: 'Your Crowdwide verification code',
    text: `${bodyText}\n\nYour verification code is ${code}\n\nThis code expires in 15 minutes. Never share it with anyone.\n\nContinue verification: ${verifyUrl}`,
    html: brandedEmail({
      heading: 'Verify your email',
      message: bodyText,
      preheader: 'One quick step to join the Crowdwide community',
      eyebrow: 'WELCOME',
      tone: 'success',
      greeting: user.name,
      steps: ['Return to your verification screen.', 'Enter the one-time code below.'],
      code,
      codeNote: 'Expires in 15 minutes',
      actionUrl: verifyUrl,
      actionLabel: 'Continue verification',
      note: 'This code expires in 15 minutes. Never share it with anyone; Crowdwide will never ask you to do so.'
    })
  };
  await deliver(message, `Verification code for ${user.email}: ${code}`);
}

async function sendSecurityAlert(user, { subject, heading, message, details = [], tone = 'default', note = 'If you do not recognize this activity, change your password and review your account security.' }) {
  const mail = {
    from: fromAddress(),
    to: user.email,
    subject,
    text: [message, ...details.map(({ label, value }) => `${label}: ${value}`), note].filter(Boolean).join('\n\n'),
    html: brandedEmail({ heading, message, preheader: subject, details, note, greeting: user.name, tone })
  };
  await deliver(mail, `${subject} for ${user.email}: ${message}`);
}

async function sendNewDeviceAlert(user, details) {
  return sendSecurityAlert(user, {
    subject: 'New Crowdwide sign-in',
    heading: 'A new device signed in',
    tone: 'warning',
    message: 'We noticed a sign-in to your Crowdwide account from a device or location we have not seen before. Review the details below.',
    details: [
      { label: 'IP address', value: details.ipAddress || 'Unavailable' },
      { label: 'Browser', value: details.userAgent || 'Unavailable' }
    ],
    note: 'If this was you, no action is needed. If you do not recognize this sign-in, change your password and review account security.'
  });
}

async function sendPasswordResetLink(user, resetUrl) {
  const message = 'We received a request to reset your Crowdwide password. This link expires in 30 minutes. If you did not request this, you can safely ignore this email and your password will stay the same.';
  const mail = {
    from: fromAddress(),
    to: user.email,
    subject: 'Reset your Crowdwide password',
    text: `${message}\n\nReset password: ${resetUrl}`,
    html: brandedEmail({
      heading: 'Reset your password',
      message: 'We received a request to reset your Crowdwide password. Use the button below to choose a new password.',
      preheader: 'Your Crowdwide password reset link',
      eyebrow: 'PASSWORD RESET',
      greeting: user.name,
      steps: ['Choose a new password you do not use elsewhere.', 'Return to sign in after the reset is complete.'],
      actionUrl: resetUrl,
      actionLabel: 'Choose a new password',
      note: 'This link expires in 30 minutes and can be used once. If you did not request a reset, ignore this email; your password will remain unchanged.'
    })
  };
  await deliver(mail, `Password reset email for ${user.email} (reset link omitted)`);
}

async function sendPartnershipReceipt(application) {
  const base = env('APP_URL') || 'https://www.crowdwide.run.place';
  const message = `Thank you for asking to partner with Crowdwide. We received the request for ${application.organizationName} and an administrator will review it. We will email you at this address with the decision.\n\nKeep your reference number: ${application.reference}.`;
  const mail = {
    from: fromAddress(),
    to: application.contactEmail,
    subject: `We received your Crowdwide partnership request (${application.reference})`,
    text: `${message}\n\nPartnership Terms: ${base}/partnerships/terms`,
    html: brandedEmail({
      heading: 'Partnership request received',
      message,
      preheader: 'Your Crowdwide partnership request is in review',
      eyebrow: 'PARTNERSHIPS',
      greeting: application.contactName,
      details: [{ label: 'Reference', value: application.reference }, { label: 'Organization', value: application.organizationName }, { label: 'Website', value: application.websiteUrl }],
      steps: ['An administrator reviews your request.', 'You receive the decision by email.', 'If approved, you may use the Crowdwide name and logo under the Brand Guidelines.'],
      actionUrl: `${base}/partnerships/terms`,
      actionLabel: 'Read the Partnership Terms',
      note: 'If you did not send this request, you can ignore this email. Nothing happens unless the request is approved.'
    })
  };
  return deliver(mail, `Partnership receipt for ${application.contactEmail} (${application.reference})`);
}

async function sendPartnershipDecision(application) {
  const base = env('APP_URL') || 'https://www.crowdwide.run.place';
  const approved = application.status === 'approved';
  const message = approved
    ? `Good news: ${application.organizationName} is now a Crowdwide partner. We will list your name and logo on Crowdwide once your logo has been added, and you may now display the Crowdwide name and logo on your website under the Partner Brand Guidelines.${application.decisionReason ? `\n\nNote from the team: ${application.decisionReason}` : ''}`
    : `Thank you for your interest in partnering with Crowdwide. After review we are not able to approve the request for ${application.organizationName} at this time.\n\nReason: ${application.decisionReason || 'Not provided.'}\n\nYou are welcome to apply again once the points above have been addressed.`;
  const mail = {
    from: fromAddress(),
    to: application.contactEmail,
    subject: approved ? 'Welcome to the Crowdwide partner program' : 'Update on your Crowdwide partnership request',
    text: `${message}\n\nReference: ${application.reference}\nBrand guidelines: ${base}/partnerships/brand-guidelines`,
    html: brandedEmail({
      heading: approved ? 'Your partnership is approved' : 'Your partnership request was not approved',
      message,
      preheader: approved ? 'You are now a Crowdwide partner' : 'A decision on your partnership request',
      eyebrow: 'PARTNERSHIPS',
      tone: approved ? 'success' : 'warning',
      greeting: application.contactName,
      details: [{ label: 'Reference', value: application.reference }],
      actionUrl: `${base}/partnerships/brand-guidelines`,
      actionLabel: approved ? 'Get the brand kit' : 'Partnership information',
      note: approved
        ? 'Either side may end the partnership at any time as described in the Partnership Terms.'
        : 'This decision does not affect your Crowdwide account, if you have one.'
    })
  };
  return deliver(mail, `Partnership decision (${application.status}) for ${application.contactEmail}`);
}

function postEmailCard(post, appUrl, index) {
  const url = safeEmailUrl(`${appUrl}/posts/${post._id}`);
  if (!url) return '';
  const body = preview(post.body, 260);
  const author = post.author?.name || 'Crowdwide member';
  const type = post.type === 'article' ? 'Article' : post.type === 'poll' ? 'Poll' : 'Post';
  const community = post.community?.name ? `<span class="em-muted" style="color:#737b91;"> · ${escapeHtml(post.community.name)}</span>` : '';
  const pollQuestion = post.type === 'poll' && post.poll?.question ? `<p class="em-h" style="margin:0 0 8px;color:#252b45;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;line-height:1.5;">${escapeHtml(post.poll.question)}</p>` : '';
  return `<tr><td style="padding:0 0 12px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="em-card" style="width:100%;border:1px solid #e2e5f0;border-radius:13px;background-color:#ffffff;"><tr><td style="padding:16px 18px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td class="em-muted" style="color:#626a88;font-family:Arial,sans-serif;font-size:12px;line-height:1.5;"><strong class="em-strong" style="color:#414966;">${escapeHtml(author)}</strong>${community}</td><td align="right" style="color:#5962d7;font-family:Arial,sans-serif;font-size:10px;font-weight:bold;letter-spacing:.6px;">${escapeHtml(type.toUpperCase())} · ${index}</td></tr></table>${pollQuestion}<p class="em-p" style="margin:9px 0 13px;color:#30364b;font-family:Arial,sans-serif;font-size:14px;line-height:1.7;">${escapeHtml(body)}</p><a class="em-pill" href="${escapeHtml(url)}" style="display:inline-block;padding:9px 13px;border-radius:8px;background-color:#f0f1ff;color:#4d56d8;font-family:Arial,sans-serif;font-size:12px;font-weight:bold;text-decoration:none;">Read conversation &nbsp;&rarr;</a></td></tr></table></td></tr>`;
}

async function sendWeeklyNewsletter(user, { personalizedPosts = [], trendingPosts = [], communityPosts = [] }) {
  const appUrl = (safeEmailUrl(env('APP_URL') || 'https://www.crowdwide.run.place') || 'https://www.crowdwide.run.place').replace(/\/$/, '');
  const posts = [...personalizedPosts, ...trendingPosts, ...communityPosts];
  if (!posts.length) return false;
  let cardNumber = 0;
  const section = (heading, description, rows) => rows.length
    ? `<tr><td style="padding:26px 0 0;"><div style="margin-bottom:5px;color:#5c63ed;font-family:Arial,sans-serif;font-size:10px;font-weight:bold;letter-spacing:1.2px;text-transform:uppercase;">${rows.length} selected for you</div><h2 class="em-h" style="margin:0;color:#202641;font-family:Arial,sans-serif;font-size:19px;line-height:1.35;">${heading}</h2><p class="em-muted" style="margin:5px 0 13px;color:#737b91;font-family:Arial,sans-serif;font-size:12px;line-height:1.5;">${description}</p><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${rows.map((post) => postEmailCard(post, appUrl, ++cardNumber)).join('')}</table></td></tr>`
    : '';
  const html = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;"><tr><td class="em-soft" style="padding:18px 20px;background-color:#f2f3ff;border:1px solid #e0e2ff;border-radius:12px;"><div style="margin-bottom:7px;color:#5c63ed;font-family:Arial,sans-serif;font-size:10px;font-weight:bold;letter-spacing:1.4px;">YOUR PERSONALIZED EDITION</div><p class="em-h" style="margin:0;color:#252b45;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;line-height:1.5;">${posts.length} conversations, ideas, and communities to explore</p><p style="margin:5px 0 0;color:#68708a;font-family:Arial,sans-serif;font-size:12px;line-height:1.5;">A blend of your interests, what's trending, and communities you may enjoy.</p></td></tr>${section('Picked for you', 'Posts from people and topics that match your interests.', personalizedPosts)}${section('Trending this week', 'Conversations resonating across Crowdwide.', trendingPosts)}${section('From communities you may like', 'Community conversations connected to your interests.', communityPosts)}<tr><td style="padding:10px 0 0;"><a href="${escapeHtml(appUrl)}/posts" style="display:block;padding:13px 18px;border-radius:9px;background-color:#5c63ed;color:#ffffff;font-family:Arial,sans-serif;font-size:13px;font-weight:bold;text-align:center;text-decoration:none;">Explore more posts &nbsp;&rarr;</a></td></tr></table>`;
  const text = posts.map((post) => `${post.author?.name || 'Crowdwide member'}: ${preview(post.body, 260)}\n${appUrl}/posts/${post._id}`).join('\n\n');
  return deliver({
    from: fromAddress(),
    to: user.email,
    subject: 'Your Crowdwide weekly: ideas and conversations for you',
    text: `Your personalized Crowdwide edition: ${personalizedPosts.length} picks for you, ${trendingPosts.length} trending conversations, and ${communityPosts.length} community posts.\n\n${text}\n\nExplore more posts: ${appUrl}/posts\nManage this email in Settings: ${appUrl}/settings/notifications`,
    html: brandedEmail({
      heading: `A week on Crowdwide${user.name ? `, ${user.name.split(' ')[0]}` : ''}`,
      message: 'A considered mix of your interests, lively conversations, and communities worth discovering.',
      preheader: `${posts.length} conversations and community posts selected for you`,
      eyebrow: 'YOUR WEEKLY DIGEST',
      contentHtml: html,
      manageUrl: `${appUrl}/settings/notifications`,
      note: 'This weekly email is optional. You can turn it off any time from Email preferences below.'
    })
  }, `Weekly newsletter for ${user.email}`);
}

async function sendUnreadNotificationSummary(user, notifications = []) {
  const appUrl = (safeEmailUrl(env('APP_URL') || 'https://www.crowdwide.run.place') || 'https://www.crowdwide.run.place').replace(/\/$/, '');
  const entries = notifications.map((notification) => {
    const url = notification.post ? safeEmailUrl(`${appUrl}/posts/${notification.post}`) : safeEmailUrl(`${appUrl}/notifications`);
    const actor = notification.actor?.name || 'Crowdwide';
    const initial = escapeHtml(String(actor).trim().charAt(0).toUpperCase() || 'C');
    return `<tr><td class="em-line em-p" style="padding:12px 4px;border-bottom:1px solid #e0e2f0;color:#252b45;font-family:Arial,sans-serif;font-size:13px;line-height:1.6;"><table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr><td width="40" valign="top"><div class="em-pill" style="width:30px;height:30px;border-radius:50%;background-color:#eceeff;color:#4d56d8;font-family:Arial,sans-serif;font-size:13px;font-weight:bold;line-height:30px;text-align:center;">${initial}</div></td><td valign="top"><strong class="em-strong">${escapeHtml(actor)}</strong> ${escapeHtml(notification.message)}${url ? ` <a class="em-link" href="${escapeHtml(url)}" style="color:#4d56d8;font-weight:bold;text-decoration:none;">Open &rsaquo;</a>` : ''}</td></tr></table></td></tr>`;
  }).join('');
  const list = entries ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:16px 0;border-collapse:collapse;">${entries}</table>` : '';
  const text = notifications.map((item) => `${item.actor?.name || 'Crowdwide'} ${item.message}`).join('\n');
  return deliver({
    from: fromAddress(),
    to: user.email,
    subject: 'You have unread notifications on Crowdwide',
    text: `You have at least five unread notifications:\n\n${text}\n\nView notifications: ${appUrl}/notifications`,
    html: brandedEmail({
      heading: 'You have unread notifications',
      message: 'Here are your latest unread updates on Crowdwide.',
      preheader: 'A quick summary of your unread notifications',
      eyebrow: 'NOTIFICATION SUMMARY',
      contentHtml: list,
      actionUrl: `${appUrl}/notifications`,
      actionLabel: 'View all notifications',
      manageUrl: `${appUrl}/settings/notifications`,
      note: `Manage notification emails in Settings: ${appUrl}/settings/notifications`
    })
  }, `Unread notification summary for ${user.email}`);
}

// Come-back reminder (24h question / 3-day discussion / 7-day win-back). The
// `reminder` object is built by services/reengagement.js. Carries a one-click
// unsubscribe (List-Unsubscribe headers + a visible link).
async function sendReengagementEmail(user, reminder) {
  const appUrl = (safeEmailUrl(reminder.appUrl || env('APP_URL') || 'https://www.crowdwide.run.place') || 'https://www.crowdwide.run.place').replace(/\/$/, '');
  const unsubscribeUrl = safeEmailUrl(reminder.unsubscribeUrl);
  const questionBlock = reminder.question?.text
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:6px 0 4px;"><tr><td class="em-soft" style="padding:20px 22px;background-color:#f2f3ff;border:1px solid #e0e2ff;border-radius:12px;"><div style="margin-bottom:8px;color:#5c63ed;font-family:Arial,sans-serif;font-size:10px;font-weight:bold;letter-spacing:1.4px;">TODAY'S QUESTION</div><p class="em-h" style="margin:0;color:#202641;font-family:Arial,sans-serif;font-size:19px;font-weight:bold;line-height:1.5;">${escapeHtml(reminder.question.text)}</p></td></tr></table>`
    : '';
  const cards = (reminder.posts || []).length
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:8px;">${reminder.posts.map((post, index) => postEmailCard(post, appUrl, index + 1)).join('')}</table>`
    : '';
  const unsubscribeLine = unsubscribeUrl
    ? `<p class="em-muted" style="margin:18px 0 0;color:#737b91;font-family:Arial,sans-serif;font-size:12px;line-height:1.6;">Not for you? <a class="em-link" href="${escapeHtml(unsubscribeUrl)}" style="color:#4d56d8;">Stop these reminders</a> with one click.</p>`
    : '';
  const text = [
    reminder.heading,
    '',
    reminder.message,
    reminder.question?.text ? `\nToday's question: ${reminder.question.text}` : '',
    ...(reminder.posts || []).map((post) => `\n${post.author?.name || 'Crowdwide member'}: ${preview(post.body || post.poll?.question || '', 200)}\n${appUrl}/posts/${post._id}`),
    `${reminder.actionLabel}: ${reminder.actionUrl}`,
    unsubscribeUrl ? `\nStop these reminders: ${unsubscribeUrl}` : ''
  ].filter((line) => line !== null && line !== undefined).join('\n');
  return deliver({
    from: fromAddress(),
    to: user.email,
    subject: reminder.subject,
    text,
    ...(unsubscribeUrl ? { headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } } : {}),
    html: brandedEmail({
      heading: reminder.heading,
      message: reminder.message,
      greeting: reminder.firstName || '',
      preheader: reminder.preheader,
      eyebrow: reminder.eyebrow || 'FROM CROWDWIDE',
      details: reminder.stats || [],
      contentHtml: `${questionBlock}${cards}${unsubscribeLine}`,
      actionUrl: reminder.actionUrl,
      actionLabel: reminder.actionLabel,
      manageUrl: `${appUrl}/settings/notifications`,
      note: reminder.note
    })
  }, `Re-engagement (${reminder.stage}) for ${user.email}`);
}

// Generic lifecycle email (welcome series, first reply). `content` = { subject,
// eyebrow, heading, message, preheader, firstName, steps[], items[{title,text,url}],
// quote:{author,text}, details[], actionUrl, actionLabel, note, unsubscribeUrl, label }.
async function sendLifecycleEmail(user, content) {
  const appUrl = (safeEmailUrl(content.appUrl || env('APP_URL') || 'https://www.crowdwide.run.place') || 'https://www.crowdwide.run.place').replace(/\/$/, '');
  const unsubscribeUrl = safeEmailUrl(content.unsubscribeUrl);
  const quote = content.quote?.text
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:6px 0 4px;"><tr><td class="em-soft" style="padding:16px 18px;background-color:#f2f3ff;border-left:3px solid #5c63ed;border-radius:0 10px 10px 0;"><div class="em-muted" style="margin-bottom:6px;color:#626a88;font-family:Arial,sans-serif;font-size:11px;font-weight:bold;letter-spacing:.6px;">${escapeHtml(String(content.quote.author || 'Crowdwide member').toUpperCase())} SAID</div><p class="em-p" style="margin:0;color:#30364b;font-family:Arial,sans-serif;font-size:15px;line-height:1.7;">${escapeHtml(content.quote.text)}</p></td></tr></table>`
    : '';
  const items = (content.items || []).map((item) => {
    const url = safeEmailUrl(item.url);
    return `<tr><td style="padding:0 0 10px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="em-card" style="border:1px solid #e2e5f0;border-radius:12px;background-color:#ffffff;"><tr><td style="padding:14px 16px;"><div class="em-h" style="color:#252b45;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;line-height:1.4;">${escapeHtml(item.title)}</div><p class="em-p" style="margin:5px 0 ${url ? '10' : '0'}px;color:#4b5268;font-family:Arial,sans-serif;font-size:13px;line-height:1.6;">${escapeHtml(item.text || '')}</p>${url ? `<a class="em-pill" href="${escapeHtml(url)}" style="display:inline-block;padding:8px 12px;border-radius:8px;background-color:#f0f1ff;color:#4d56d8;font-family:Arial,sans-serif;font-size:12px;font-weight:bold;text-decoration:none;">${escapeHtml(item.linkLabel || 'Take a look')} &nbsp;&rarr;</a>` : ''}</td></tr></table></td></tr>`;
  }).join('');
  const itemsBlock = items ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:12px;">${items}</table>` : '';
  const unsubscribeLine = unsubscribeUrl
    ? `<p class="em-muted" style="margin:18px 0 0;color:#737b91;font-family:Arial,sans-serif;font-size:12px;line-height:1.6;">Not for you? <a class="em-link" href="${escapeHtml(unsubscribeUrl)}" style="color:#4d56d8;">Stop these emails</a> with one click.</p>`
    : '';
  const text = [
    content.heading, '', content.message,
    content.quote?.text ? `\n${content.quote.author || 'Someone'} said: ${content.quote.text}` : '',
    ...(content.steps || []).map((step, index) => `${index + 1}. ${step}`),
    ...(content.items || []).map((item) => `\n${item.title}\n${item.text || ''}${item.url ? `\n${item.url}` : ''}`),
    `${content.actionLabel}: ${content.actionUrl}`,
    unsubscribeUrl ? `\nStop these emails: ${unsubscribeUrl}` : ''
  ].join('\n');
  return deliver({
    from: fromAddress(),
    to: user.email,
    subject: content.subject,
    text,
    ...(unsubscribeUrl ? { headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } } : {}),
    html: brandedEmail({
      heading: content.heading,
      message: content.message,
      greeting: content.firstName || '',
      preheader: content.preheader,
      eyebrow: content.eyebrow || 'FROM CROWDWIDE',
      steps: content.steps || [],
      details: content.details || [],
      contentHtml: `${quote}${itemsBlock}${unsubscribeLine}`,
      actionUrl: content.actionUrl,
      actionLabel: content.actionLabel,
      manageUrl: `${appUrl}/settings/notifications`,
      note: content.note
    })
  }, `${content.label || 'Lifecycle email'} for ${user.email}`);
}

module.exports = {
  sendVerificationCode,
  sendReengagementEmail,
  sendLifecycleEmail,
  sendNewDeviceAlert,
  sendSecurityAlert,
  sendPasswordResetLink,
  sendWeeklyNewsletter,
  sendUnreadNotificationSummary,
  sendPartnershipReceipt,
  sendPartnershipDecision,
  verifyMailConfig,
  sendTestEmail,
  explainMailError
};
