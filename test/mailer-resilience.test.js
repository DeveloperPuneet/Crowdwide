const test = require('node:test');
const assert = require('node:assert/strict');

process.env.MAIL_HOST = 'smtp.example.com';
process.env.MAIL_PORT = '587';
process.env.MAIL_USER = 'test-user';
process.env.MAIL_PASS = 'test-pass';
delete process.env.MAIL_PROVIDER; // use the generic SMTP branch, not gmail

const nodemailer = require('nodemailer');
const { sendVerificationCode, sendSecurityAlert, sendNewDeviceAlert, sendPasswordResetLink } = require('../src/services/mailer');

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
