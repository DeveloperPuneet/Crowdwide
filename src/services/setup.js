// "Finish setting up": the things a member skipped or never did that make the
// site work better for them (or, for staff, keep their account safe).
//
//  - Shown as a checklist card on the dashboard (everything pending, right away).
//  - Followed up by ONE in-app notification (plus push for required items) at
//    most every 3 days, never repeating the same item within 14 days.
//  - "Required" items cannot be dismissed; recommended ones can.
const User = require('../models/User');
const Notification = require('../models/Notification');
const { sendPushToUser } = require('./push');
const logger = require('./logger');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NUDGE_GAP_MS = 3 * DAY_MS;
const REPEAT_ITEM_MS = 14 * DAY_MS;

const isStaff = (user) => ['admin', 'moderator'].includes(user.role);

// Each task: done(user) and, when it applies at all, applies(user). `afterHours` is how
// long to wait (from `since`) before a notification is sent - the card shows it at once.
const TASKS = [
  { key: 'panel-password', required: true, icon: 'lock', title: 'Set your panel password', text: 'You signed in with Google or GitHub, so the admin and moderator panels have no password yet.', url: '/dashboard', cta: 'Set password', applies: (u) => isStaff(u), done: (u) => u.passwordSet !== false, afterHours: 0 },
  { key: 'staff-2fa', required: true, icon: 'shield-check', title: 'Turn on two-factor sign-in', text: 'Staff accounts can change and remove other people\'s content, so they need a second step at sign-in.', url: '/settings/security/2fa', cta: 'Set up 2FA', applies: (u) => isStaff(u), done: (u) => Boolean(u.twoFactorEnabled), afterHours: 0 },
  { key: 'onboarding', required: true, icon: 'rocket', title: 'Finish the welcome tour', text: 'You skipped it. Pick interests, people and communities so your feed starts out relevant.', url: '/welcome', cta: 'Continue', applies: (u) => Boolean(u.onboardingSkippedAt) && !u.onboardingCompletedAt, done: () => false, since: (u) => u.onboardingSkippedAt, afterHours: 6 },
  { key: 'interests', required: true, icon: 'hash', title: 'Choose at least 3 interests', text: 'Your “For you” feed is built from them.', url: '/settings/profile', cta: 'Add interests', applies: () => true, done: (u) => (u.hashtags || []).length >= 3, afterHours: 24 },
  { key: 'photo', icon: 'camera', title: 'Add a profile photo', text: 'People follow people they can recognise.', url: '/settings/profile', cta: 'Add photo', applies: () => true, done: (u) => Boolean(u.profilePicture), afterHours: 48 },
  { key: 'bio', icon: 'edit', title: 'Write a short bio', text: 'One line about what you care about is enough.', url: '/settings/profile', cta: 'Write bio', applies: () => true, done: (u) => Boolean(String(u.bio || '').trim()), afterHours: 48 },
  { key: 'follow', icon: 'user-plus', title: 'Follow 3 people', text: 'Following people you like improves your feed and gets you noticed back.', url: '/people', cta: 'Find people', applies: () => true, done: (u) => (u.following || []).length >= 3, afterHours: 72 },
  { key: 'community', icon: 'globe', title: 'Join a community', text: 'Communities are where most conversations happen.', url: '/communities', cta: 'Browse communities', applies: () => true, done: (u) => (u.joinedCommunities || []).length >= 1, afterHours: 72 },
  { key: 'first-post', icon: 'sparkles', title: 'Share your first post', text: 'A sentence is enough. Answer today\'s question if you are stuck.', url: '/dashboard?ask=qotd', cta: 'Write a post', applies: () => true, done: (u, facts) => (facts?.posts || 0) + (facts?.comments || 0) > 0, afterHours: 96 },
  { key: 'two-factor', icon: 'shield-check', title: 'Protect your account with 2FA', text: 'A second step at sign-in keeps your account yours.', url: '/settings/security/2fa', cta: 'Set up 2FA', applies: (u) => !isStaff(u), done: (u) => Boolean(u.twoFactorEnabled), afterHours: 24 * 7 },
  { key: 'push', icon: 'bell', title: 'Turn on push notifications', text: 'Hear about replies and messages even when Crowdwide is closed.', url: '/settings/notifications', cta: 'Turn on', applies: () => true, done: (u) => Boolean(u.pushNotificationsEnabled), afterHours: 24 * 7 }
];
const TASK_BY_KEY = new Map(TASKS.map((task) => [task.key, task]));

// Pending checklist items for a member, required ones first. `facts` may carry
// { posts, comments }; without it the first-post item is simply not shown.
function pendingSetup(user, { facts = null, now = new Date() } = {}) {
  const dismissed = new Set(user.setupDismissed || []);
  return TASKS
    .filter((task) => task.applies(user) && !task.done(user, facts))
    .filter((task) => task.required || !dismissed.has(task.key))
    .filter((task) => task.key !== 'first-post' || facts)
    .map((task) => {
      const since = new Date((task.since ? task.since(user) : user.createdAt) || now);
      return { key: task.key, required: Boolean(task.required), icon: task.icon, title: task.title, text: task.text, url: task.url, cta: task.cta, dueAt: new Date(since.getTime() + task.afterHours * HOUR_MS) };
    })
    .sort((a, b) => Number(b.required) - Number(a.required));
}

// Summary for the dashboard card: { done, total, pending: [...] }.
function setupSummary(user, options = {}) {
  const pending = pendingSetup(user, options);
  const applicable = TASKS.filter((task) => task.applies(user) && (task.required || !(user.setupDismissed || []).includes(task.key)) && (task.key !== 'first-post' || options.facts));
  return { pending, total: applicable.length, done: applicable.length - pending.length };
}

// Which item (if any) deserves a notification now, for one member.
function nextNudge(user, { facts = null, now = new Date() } = {}) {
  const lastAt = user.setupNudge?.lastAt ? new Date(user.setupNudge.lastAt) : null;
  if (lastAt && now - lastAt < NUDGE_GAP_MS) return null;
  const recent = new Set((user.setupNudge?.sent || []).filter((entry) => entry.at && now - new Date(entry.at) < REPEAT_ITEM_MS).map((entry) => entry.key));
  const due = pendingSetup(user, { facts, now }).filter((item) => item.dueAt <= now && !recent.has(item.key));
  if (!due.length) return null;
  return { item: due[0], others: due.length - 1 };
}

async function sendSetupNudges({ now = new Date(), limit = 100 } = {}) {
  const result = { checked: 0, sent: 0 };
  const members = await User.find({
    isVerified: true,
    createdAt: { $lte: new Date(now.getTime() - 6 * HOUR_MS) },
    $and: [
      { $or: [{ suspendedUntil: null }, { suspendedUntil: { $lte: now } }] },
      { $or: [{ 'setupNudge.lastAt': null }, { 'setupNudge.lastAt': { $lte: new Date(now.getTime() - NUDGE_GAP_MS) } }] },
      { $or: [{ lastActiveAt: { $gte: new Date(now.getTime() - 30 * DAY_MS) } }, { lastActiveAt: null }] }
    ]
  }).select('_id name role createdAt passwordSet twoFactorEnabled onboardingSkippedAt onboardingCompletedAt hashtags profilePicture bio following joinedCommunities pushNotificationsEnabled pushSubscriptions setupNudge setupDismissed')
    .sort({ 'setupNudge.lastAt': 1 }).limit(400).lean();
  for (const member of members) {
    if (result.sent >= limit) break;
    result.checked += 1;
    try {
      const nudge = nextNudge(member, { now });
      if (!nudge) continue;
      // One open reminder at a time: do not stack a second while the first is unread.
      if (await Notification.exists({ recipient: member._id, type: 'setup', readAt: null })) continue;
      const claim = await User.updateOne(
        { _id: member._id, $or: [{ 'setupNudge.lastAt': null }, { 'setupNudge.lastAt': { $lte: new Date(now.getTime() - NUDGE_GAP_MS) } }] },
        { $set: { 'setupNudge.lastAt': now }, $push: { 'setupNudge.sent': { $each: [{ key: nudge.item.key, at: now }], $slice: -20 } } }
      );
      if (!claim.modifiedCount) continue;
      const more = nudge.others > 0 ? ` (and ${nudge.others} more step${nudge.others === 1 ? '' : 's'})` : '';
      const message = `${nudge.item.required ? 'Action needed: ' : 'Finish setting up: '}${nudge.item.title}${more}.`;
      await Notification.create({ recipient: member._id, type: 'setup', setupKey: nudge.item.key, message, url: nudge.item.url });
      if (nudge.item.required && member.pushNotificationsEnabled) {
        await sendPushToUser(member._id, { title: 'Crowdwide', body: message, url: nudge.item.url }).catch((error) => logger.warn('Setup push failed', error));
      }
      result.sent += 1;
    } catch (error) {
      logger.warn('Setup nudge failed for one member', error);
    }
  }
  return result;
}

module.exports = { TASKS, TASK_BY_KEY, pendingSetup, setupSummary, nextNudge, sendSetupNudges };
