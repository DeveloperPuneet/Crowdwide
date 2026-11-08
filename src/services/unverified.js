// People who sign up but never enter their code. They get up to four short
// emails (1 hour, 1 day, 3 days and 7 days after signing up), each with a
// one-click link that confirms the address and signs them in. After the fourth
// we stop, and nothing is sent to accounts older than 30 days.
const crypto = require('crypto');
const mongoose = require('mongoose');
const User = require('../models/User');
const Post = require('../models/Post');
const Community = require('../models/Community');
const { sendLifecycleEmail } = require('./mailer');
const logger = require('./logger');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const LINK_LIFETIME_MS = 7 * DAY_MS;
const MIN_GAP_MS = 20 * HOUR_MS;
const MAX_ACCOUNT_AGE_MS = 30 * DAY_MS;

const STAGES = [
  { id: 'verify-1', afterHours: 1 },
  { id: 'verify-2', afterHours: 24 },
  { id: 'verify-3', afterHours: 72 },
  { id: 'verify-4', afterHours: 168 }
];

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

function newLinkToken() {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, hash: sha256(token), expires: new Date(Date.now() + LINK_LIFETIME_MS) };
}

// Constant-time check of a link token against what is stored for the member.
function linkMatches(user, token) {
  if (!user?.verificationLinkHash || !user.verificationLinkExpires || user.verificationLinkExpires.getTime() < Date.now()) return false;
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return false;
  return crypto.timingSafeEqual(Buffer.from(sha256(token), 'hex'), Buffer.from(user.verificationLinkHash, 'hex'));
}

// The stage to send now, or null. If the worker was down and several stages are
// overdue, only the latest one is sent (the earlier ones are marked as handled).
function dueStage(user, now = new Date()) {
  if (!user || user.isVerified) return null;
  const age = now - new Date(user.createdAt);
  if (age > MAX_ACCOUNT_AGE_MS || age < STAGES[0].afterHours * HOUR_MS) return null;
  const sent = new Set(user.verificationReminders?.sent || []);
  const lastAt = user.verificationReminders?.lastSentAt ? new Date(user.verificationReminders.lastSentAt) : null;
  if (lastAt && now - lastAt < MIN_GAP_MS) return null;
  const due = STAGES.filter((stage) => !sent.has(stage.id) && age >= stage.afterHours * HOUR_MS);
  if (!due.length) return null;
  const stage = due[due.length - 1];
  return { ...stage, skipped: due.slice(0, -1).map((entry) => entry.id) };
}

function buildEmail(stageId, user, { link, posts, communities, appUrl }) {
  const waiting = posts || communities
    ? `${posts ? `${posts.toLocaleString()} posts` : ''}${posts && communities ? ' in ' : ''}${communities ? `${communities.toLocaleString()} communities` : ''} are already there.`
    : 'Conversations are already happening.';
  const base = { firstName: (user.name || '').split(/\s+/)[0], appUrl, actionUrl: link, actionLabel: 'Verify my account', eyebrow: 'YOUR ACCOUNT', label: `Verification reminder (${stageId})` };
  const how = ['Tap the button below.', 'We confirm your email and sign you in.', 'Pick a few interests and start reading.'];
  if (stageId === 'verify-1') return { ...base, subject: 'One tap to finish joining Crowdwide', heading: 'You are one tap away', preheader: 'Confirm your email to start using your account', message: `You created a Crowdwide account but have not confirmed your email yet, so you cannot sign in. ${waiting}`, steps: how, note: 'This link works for 7 days and only once. Signing in with your password also sends a fresh code.' };
  if (stageId === 'verify-2') return { ...base, subject: 'Your Crowdwide account is waiting for you', heading: 'Your account is ready when you are', preheader: 'Verify your email and take a first look', message: `Yesterday you signed up for Crowdwide, but your email is still unconfirmed. ${waiting} It takes about ten seconds to get in.`, steps: how, note: 'If you did not sign up, ignore this email and nothing will happen.' };
  if (stageId === 'verify-3') return { ...base, subject: 'Still want in? Verify your Crowdwide email', heading: 'Do not lose your spot', preheader: 'Your verification link is still active', message: `You still have a Crowdwide account waiting on a confirmed email. ${waiting}\n\nYour link stays valid for a few more days.`, steps: how, note: 'If this was a mistake you can simply ignore this email.' };
  return { ...base, subject: 'Last reminder: verify your Crowdwide account', heading: 'One last reminder', preheader: 'We will not email you about this again', message: `This is the last reminder about the account you created a week ago. Confirm your email to use it, or ignore this and we will stop here. ${waiting}`, steps: how, note: 'We will not send any more reminders after this one.' };
}

async function sendVerificationReminders({ now = new Date(), limit = 25, dryRun = false } = {}) {
  const result = { candidates: 0, due: 0, sent: 0 };
  const candidates = await User.find({
    isVerified: false,
    createdAt: { $gte: new Date(now.getTime() - MAX_ACCOUNT_AGE_MS), $lte: new Date(now.getTime() - STAGES[0].afterHours * HOUR_MS) },
    'verificationReminders.sent.3': { $exists: false }
  }).select('_id name email createdAt isVerified verificationReminders').sort({ createdAt: 1 }).limit(200).lean();
  result.candidates = candidates.length;
  const due = candidates.map((user) => ({ user, stage: dueStage(user, now) })).filter((entry) => entry.stage);
  result.due = due.length;
  if (!due.length || dryRun) return result;

  const appUrl = (process.env.APP_URL || 'https://www.crowdwide.run.place').replace(/\/$/, '');
  const [posts, communities] = await Promise.all([Post.countDocuments({ status: 'published' }).catch(() => 0), Community.countDocuments({ isPrivate: { $ne: true } }).catch(() => 0)]);
  for (const { user, stage } of due) {
    if (result.sent >= limit) break;
    try {
      const claim = await User.updateOne(
        { _id: user._id, isVerified: false, 'verificationReminders.sent': { $ne: stage.id } },
        { $addToSet: { 'verificationReminders.sent': { $each: [...stage.skipped, stage.id] } }, $set: { 'verificationReminders.lastSentAt': now } }
      );
      if (!claim.modifiedCount) continue;
      const link = newLinkToken();
      await User.updateOne({ _id: user._id, isVerified: false }, { $set: { verificationLinkHash: link.hash, verificationLinkExpires: link.expires } });
      const url = `${appUrl}/auth/verify-email/${user._id}/${link.token}`;
      const delivered = await sendLifecycleEmail(user, buildEmail(stage.id, user, { link: url, posts, communities, appUrl }));
      if (!delivered) {
        // Not delivered: let the next tick try this stage again.
        await User.updateOne({ _id: user._id }, { $pull: { 'verificationReminders.sent': stage.id }, $unset: { 'verificationReminders.lastSentAt': 1 } });
        continue;
      }
      result.sent += 1;
    } catch (error) {
      logger.error('Verification reminder failed for one account', error);
    }
  }
  return result;
}

module.exports = { STAGES, sha256, newLinkToken, linkMatches, dueStage, buildEmail, sendVerificationReminders, LINK_LIFETIME_MS };
