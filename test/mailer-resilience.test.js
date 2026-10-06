const test = require('node:test');
const assert = require('node:assert/strict');

process.env.MAIL_HOST = 'smtp.example.com';
process.env.MAIL_PORT = '587';
process.env.MAIL_USER = 'test-user';
process.env.MAIL_PASS = 'test-pass';
delete process.env.MAIL_PROVIDER; // use the generic SMTP branch, not gmail

const nodemailer = require('nodemailer');
const { sendVerificationCode, sendSecurityAlert, sendNewDeviceAlert, sendPasswordResetLink, sendWeeklyNewsletter } = require('../src/services/mailer');

function mockFailingTransport(t) {
  t.mock.method(nodemailer, 'createTransport', () => ({
    sendMail: () => Promise.reject(new Error('ECONNREFUSED: simulated mail provider outage'))
  }));
}

function mockWorkingTransport(t) {
  const sendMailCalls = [];
  t.mock.method(nodemailer, 'createTransport', () => ({
    sendMail: (mail) => { sendMailCalls.push(mail); return Promise.resolve(); }
  }));
  return sendMailCalls;
}

test('sendVerificationCode does not throw when the mail provider is down (this used to break registration/login)', async (t) => {
  mockFailingTransport(t);
  await assert.doesNotReject(sendVerificationCode({ email: 'pat@example.com' }, '123456'));
});

test('sendSecurityAlert does not throw when the mail provider is down (this used to hang 2FA/password-reset requests)', async (t) => {
  mockFailingTransport(t);
  await assert.doesNotReject(sendSecurityAlert({ email: 'pat@example.com' }, { subject: 'x', heading: 'x', message: 'x' }));
});

test('sendNewDeviceAlert does not throw when the mail provider is down (this used to break every non-first login)', async (t) => {
  mockFailingTransport(t);
  await assert.doesNotReject(sendNewDeviceAlert({ email: 'pat@example.com' }, { ipAddress: '1.2.3.4', userAgent: 'test-agent' }));
});

test('sendPasswordResetLink does not throw when the mail provider is down', async (t) => {
  mockFailingTransport(t);
  await assert.doesNotReject(sendPasswordResetLink({ email: 'pat@example.com' }, 'https://example.com/auth/reset?token=abc'));
});

test('mail still actually sends normally when the provider is healthy', async (t) => {
  const sendMailCalls = mockWorkingTransport(t);
  await sendVerificationCode({ email: 'pat@example.com' }, '654321');
  assert.equal(sendMailCalls.length, 1);
  assert.equal(sendMailCalls[0].to, 'pat@example.com');
  assert.match(sendMailCalls[0].text, /654321/);
});

test('auth emails use branded layouts and escape user-controlled content', async (t) => {
  const sendMailCalls = mockWorkingTransport(t);
  await sendVerificationCode({ email: 'pat@example.com' }, '<img src=x>');
  await sendSecurityAlert({ email: 'pat@example.com' }, {
    subject: 'Security notice',
    heading: '<script>alert(1)</script>',
    message: 'A browser named <img src=x> signed in.'
  });
  await sendNewDeviceAlert({ email: 'pat@example.com' }, { ipAddress: '1.2.3.4', userAgent: '<img src=x>' });
  await sendPasswordResetLink({ email: 'pat@example.com' }, 'https://crowdwide.test/reset?token=abc&next=profile');

  const [verification, security, device, reset] = sendMailCalls;
  for (const mail of sendMailCalls) {
    assert.match(mail.html, /Crowdwide/);
    assert.match(mail.html, /background-color:#111426/);
    assert.match(mail.html, /#ff9850/);
    assert.match(mail.html, /background-color:#5c63ed/);
    assert.match(mail.html, /A fair chance at discovery/);
  }
  assert.match(verification.html, /&lt;img src=x&gt;/);
  assert.match(verification.html, /expires in 15 minutes/);
  assert.match(verification.html, /Never share it with anyone/);
  assert.match(verification.html, /Continue verification/);
  assert.match(verification.html, /bgcolor="#5c63ed"/);
  assert.match(verification.html, /background-color:#f2f3ff/);
  assert.match(verification.text, /expires in 15 minutes/);
  assert.doesNotMatch(security.html, /<script>alert\(1\)<\/script>/);
  assert.match(security.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(device.html, /IP address/);
  assert.match(device.html, /1\.2\.3\.4/);
  assert.match(device.html, /&lt;img src=x&gt;/);
  assert.match(device.text, /Browser: <img src=x>/);
  assert.match(reset.html, /href="https:\/\/crowdwide\.test\/reset\?token=abc&amp;next=profile"/);
  assert.match(reset.html, /Choose a new password/);
  assert.match(reset.html, /expires in 30 minutes/);
});

test('weekly newsletter uses three responsive sections and links to all selected posts', async (t) => {
  const sendMailCalls = mockWorkingTransport(t);
  const posts = (prefix, count, extra = {}) => Array.from({ length: count }, (_, index) => ({
    _id: `${prefix}-${index}`,
    author: { name: 'Crowdwide member' },
    body: `A useful idea ${index}`,
    ...extra
  }));
  await sendWeeklyNewsletter({ email: 'reader@example.com', name: 'Pat Reader' }, {
    personalizedPosts: posts('personal', 10),
    trendingPosts: posts('trending', 5, { type: 'poll', poll: { question: 'Which idea should we explore?' } }),
    communityPosts: posts('community', 5, { community: { name: 'Thoughtful Makers' } })
  });

  const [mail] = sendMailCalls;
  assert.ok(mail);
  assert.match(mail.html, /Picked for you/);
  assert.match(mail.html, /Trending this week/);
  assert.match(mail.html, /From communities you may like/);
  assert.match(mail.html, /Thoughtful Makers/);
  assert.match(mail.html, /Which idea should we explore\?/);
  assert.match(mail.html, /Explore more posts/);
  assert.equal((mail.html.match(/href="https:\/\/www\.crowdwide\.run\.place\/posts\/(?:personal|trending|community)-\d"/g) || []).length, 20);
  assert.match(mail.text, /10 picks for you, 5 trending conversations, and 5 community posts/);
});
