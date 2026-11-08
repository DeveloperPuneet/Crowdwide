// Badges (data, medals, progress), the "finish setting up" checklist, the unverified-account
// reminders and the security hardening (operator injection filter, password policy, secrets).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { icon, ICON_NAMES } = require('../src/utils/icons');
const { BADGES, CATEGORIES, TIERS, badgesFor, badgeProgress, badgeMedal, badgeInfo } = require('../src/utils/badges');
const setup = require('../src/services/setup');
const unverified = require('../src/services/unverified');
const { clean } = require('../src/middleware/sanitize');
const { passwordProblem } = require('../src/utils/passwordPolicy');

const views = path.join(__dirname, '..', 'src', 'views');
const HOUR = 3600 * 1000;
const NOW = new Date('2026-11-08T12:00:00Z');

// ------------------------------------------------------------------ badges
test('badge data is consistent: unique keys, real icons, known tiers and categories', () => {
  assert.ok(BADGES.length >= 40);
  assert.equal(new Set(BADGES.map((badge) => badge.key)).size, BADGES.length);
  const categories = new Set(CATEGORIES.map((category) => category.id));
  BADGES.forEach((badge) => {
    assert.ok(ICON_NAMES.includes(badge.icon), `${badge.key} uses unknown icon ${badge.icon}`);
    assert.ok(TIERS[badge.tier], `${badge.key} has unknown tier`);
    assert.ok(categories.has(badge.category), `${badge.key} has unknown category`);
    assert.ok(badge.target >= 1 && badge.metric);
  });
  // The original ten keys still exist, so nobody loses a badge they already hold.
  ['first-post', 'first-comment', 'first-reply', 'qotd', 'streak-3', 'streak-7', 'streak-30', 'posts-10', 'posts-50', 'comments-25'].forEach((key) => assert.ok(badgeInfo(key), key));
});

test('badgesFor only checks the numbers it is given', () => {
  assert.deepEqual(badgesFor({ followers: 60 }).sort(), ['followers-10', 'followers-50']);
  assert.deepEqual(badgesFor({ streak: 14, posts: null }).sort(), ['streak-14', 'streak-3', 'streak-7']);
  assert.deepEqual(badgesFor({ likes: 100, twoFactor: 0 }).sort(), ['likes-10', 'likes-100']);
  assert.ok(badgesFor({ accountDays: 400, early: 1 }).includes('veteran-365'));
  assert.deepEqual(badgesFor({}), []);
});

test('badge progress is capped and reports percentage', () => {
  const posts50 = badgeInfo('posts-50');
  assert.deepEqual(badgeProgress(posts50, { posts: 20 }), { value: 20, target: 50, pct: 40, done: false });
  assert.equal(badgeProgress(posts50, { posts: 80 }).value, 50);
  assert.equal(badgeProgress(posts50, { posts: 80 }).done, true);
  assert.equal(badgeProgress(posts50, {}).pct, 0);
});

test('every badge draws a medal; locked ones are marked; ids never clash', () => {
  const ids = new Set();
  BADGES.forEach((badge) => {
    const svg = badgeMedal(badge, { size: 50 });
    assert.match(svg, /^<svg class="badge-medal badge-tier-/);
    assert.match(svg, /aria-label="[^"]+ badge, /);
    const id = /linearGradient id="([^"]+)"/.exec(svg)[1];
    assert.ok(!ids.has(id), 'gradient ids must be unique per medal');
    ids.add(id);
  });
  assert.match(badgeMedal('streak-7', { locked: true }), /is-locked/);
  assert.match(badgeMedal('streak-7', { locked: true }), /not earned yet/);
  assert.equal(badgeMedal('no-such-badge'), '');
});

test('the gallery page renders with progress, locked and earned badges', async () => {
  const sections = CATEGORIES.map((category) => ({
    ...category,
    badges: BADGES.filter((badge) => badge.category === category.id).map((badge, index) => ({ ...badge, tierLabel: TIERS[badge.tier].label, earned: index % 2 === 0, earnedAt: new Date('2026-10-01'), progress: badgeProgress(badge, { posts: 4, streak: 2 }) }))
  }));
  const html = await ejs.renderFile(path.join(views, 'pages/badges.ejs'), {
    icon, badgeMedal, csrfToken: 't', flash: null, currentUser: { id: 'u1', name: 'A', role: 'user' }, appUrl: 'http://x', gifsEnabled: false,
    title: 'Your badges', pagePath: '/badges', noIndex: true, sections, earnedCount: 7, totalCount: BADGES.length,
    nextUp: sections[1].badges.slice(0, 2), recent: BADGES.slice(0, 3), streakInfo: { current: 3, doneToday: false }
  });
  assert.match(html, /7 <span>of 40 earned|7 <span>of \d+ earned/);
  assert.match(html, /Closest to earning/);
  assert.match(html, /class="badge-card badge-tier-bronze is-earned"/);
  assert.match(html, /is-locked/);
  assert.match(html, /3-day streak/);
});

test('notification rows show a medal for badges and an icon for setup reminders', async () => {
  const render = (n) => ejs.renderFile(path.join(views, 'partials/notification-item.ejs'), { icon, badgeMedal, notification: { _id: 'n1', createdAt: new Date(), readAt: null, ...n } });
  const badge = await render({ type: 'badge', badgeKey: 'streak-7', message: 'You earned it', url: '/badges' });
  assert.match(badge, /notification-medal/);
  assert.match(badge, /badge-medal/);
  const nudge = await render({ type: 'setup', setupKey: 'photo', message: 'Finish setting up: Add a profile photo.', url: '/settings/profile' });
  assert.match(nudge, /notification-setup/);
});

// ------------------------------------------------------------------ setup checklist
const member = (overrides = {}) => ({ _id: 'u1', role: 'user', createdAt: new Date(NOW - 5 * 24 * HOUR), hashtags: [], following: [], joinedCommunities: [], profilePicture: '', bio: '', twoFactorEnabled: false, passwordSet: true, pushNotificationsEnabled: false, setupDismissed: [], ...overrides });

test('checklist lists what is missing, required items first, and hides finished or dismissed ones', () => {
  const pending = setup.pendingSetup(member({ onboardingSkippedAt: new Date(NOW - 2 * 24 * HOUR), setupDismissed: ['push', 'bio'] }), { facts: { posts: 0, comments: 0 }, now: NOW });
  const keys = pending.map((item) => item.key);
  assert.equal(pending[0].required, true);
  assert.ok(keys.includes('onboarding') && keys.includes('interests') && keys.includes('photo'));
  assert.ok(!keys.includes('push') && !keys.includes('bio'));
  const full = member({ profilePicture: '/x.png', bio: 'hi', hashtags: ['a', 'b', 'c'], following: [1, 2, 3], joinedCommunities: [1], twoFactorEnabled: true, pushNotificationsEnabled: true, onboardingCompletedAt: NOW });
  assert.deepEqual(setup.pendingSetup(full, { facts: { posts: 1, comments: 0 }, now: NOW }), []);
});

test('staff get required password and 2FA items that cannot be dismissed', () => {
  const staff = member({ role: 'moderator', passwordSet: false, setupDismissed: ['staff-2fa', 'panel-password'] });
  const keys = setup.pendingSetup(staff, { now: NOW }).filter((item) => item.required).map((item) => item.key);
  assert.ok(keys.includes('panel-password') && keys.includes('staff-2fa'));
  assert.ok(!setup.pendingSetup(staff, { now: NOW }).some((item) => item.key === 'two-factor'), 'staff are not also shown the optional 2FA item');
  assert.equal(setup.TASK_BY_KEY.get('panel-password').required, true);
});

test('setup summary counts done versus total', () => {
  const summary = setup.setupSummary(member({ profilePicture: '/p.png', hashtags: ['a', 'b', 'c'], onboardingCompletedAt: NOW }), { facts: { posts: 0, comments: 0 } });
  assert.equal(summary.done + summary.pending.length, summary.total);
  assert.ok(summary.done >= 2);
});

test('nudges are spaced out, one item at a time, and never repeat an item within two weeks', () => {
  const user = member({ hashtags: ['a', 'b', 'c'], onboardingCompletedAt: NOW });
  const first = setup.nextNudge(user, { now: NOW });
  assert.ok(first && first.item.key);
  // Nudged yesterday: nothing yet.
  assert.equal(setup.nextNudge({ ...user, setupNudge: { lastAt: new Date(NOW - 24 * HOUR), sent: [{ key: first.item.key, at: new Date(NOW - 24 * HOUR) }] } }, { now: NOW }), null);
  // Nudged 4 days ago about that item: moves on to a different one.
  const later = setup.nextNudge({ ...user, setupNudge: { lastAt: new Date(NOW - 4 * 24 * HOUR), sent: [{ key: first.item.key, at: new Date(NOW - 4 * 24 * HOUR) }] } }, { now: NOW });
  assert.ok(later && later.item.key !== first.item.key);
  // Items are not due until their delay has passed (a day-old account is not asked for a photo).
  assert.equal(setup.nextNudge(member({ createdAt: new Date(NOW - 10 * HOUR), hashtags: ['a', 'b', 'c'] }), { now: NOW }), null);
});

test('the setup card renders required and optional items with dismiss only on optional ones', async () => {
  const summary = setup.setupSummary(member({ onboardingSkippedAt: new Date(NOW - 48 * HOUR) }), { facts: { posts: 0, comments: 0 }, now: NOW });
  const html = await ejs.renderFile(path.join(views, 'partials/setup-card.ejs'), { icon, csrfToken: 'tok', setup: summary });
  assert.match(html, /Action needed/);
  assert.match(html, /Finish the welcome tour/);
  assert.match(html, /<em>Required<\/em>/);
  assert.match(html, /action="\/setup\/dismiss"/);
  assert.equal((await ejs.renderFile(path.join(views, 'partials/setup-card.ejs'), { icon, csrfToken: 'tok', setup: { pending: [], done: 5, total: 5 } })).trim(), '');
});

// ------------------------------------------------------------------ unverified reminders
const unverifiedUser = (hoursOld, extra = {}) => ({ _id: 'u9', name: 'Ravi Kumar', email: 'r@x.com', isVerified: false, createdAt: new Date(NOW - hoursOld * HOUR), verificationReminders: {}, ...extra });

test('reminders go out at 1h, 1 day, 3 days and 7 days, once each, and then stop', () => {
  assert.equal(unverified.dueStage(unverifiedUser(0.5), NOW), null);
  assert.equal(unverified.dueStage(unverifiedUser(2), NOW).id, 'verify-1');
  assert.equal(unverified.dueStage(unverifiedUser(30, { verificationReminders: { sent: ['verify-1'], lastSentAt: new Date(NOW - 25 * HOUR) } }), NOW).id, 'verify-2');
  assert.equal(unverified.dueStage(unverifiedUser(30, { verificationReminders: { sent: ['verify-1'], lastSentAt: new Date(NOW - 5 * HOUR) } }), NOW), null, 'too soon after the last one');
  assert.equal(unverified.dueStage(unverifiedUser(200, { verificationReminders: { sent: ['verify-1', 'verify-2', 'verify-3', 'verify-4'], lastSentAt: new Date(NOW - 40 * HOUR) } }), NOW), null);
  assert.equal(unverified.dueStage(unverifiedUser(24 * 31), NOW), null, 'old abandoned sign-ups are left alone');
  assert.equal(unverified.dueStage({ ...unverifiedUser(30), isVerified: true }, NOW), null);
});

test('when several stages are overdue only the latest is sent and earlier ones are marked handled', () => {
  const stage = unverified.dueStage(unverifiedUser(100), NOW);
  assert.equal(stage.id, 'verify-3');
  assert.deepEqual(stage.skipped, ['verify-1', 'verify-2']);
});

test('verification links are single-use hashes that expire and compare safely', () => {
  const { token, hash, expires } = unverified.newLinkToken();
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.notEqual(hash, token);
  const user = { verificationLinkHash: hash, verificationLinkExpires: expires };
  assert.equal(unverified.linkMatches(user, token), true);
  assert.equal(unverified.linkMatches(user, 'a'.repeat(64)), false);
  assert.equal(unverified.linkMatches(user, { $ne: '' }), false);
  assert.equal(unverified.linkMatches(user, 'short'), false);
  assert.equal(unverified.linkMatches({ ...user, verificationLinkExpires: new Date(Date.now() - 1000) }, token), false);
  assert.equal(unverified.linkMatches({}, token), false);
});

test('each reminder email has its own wording and carries the verification link', () => {
  const link = 'https://x.test/auth/verify-email/u9/abc';
  const subjects = new Set();
  unverified.STAGES.forEach((stage) => {
    const mail = unverified.buildEmail(stage.id, unverifiedUser(10), { link, posts: 40, communities: 4, appUrl: 'https://x.test' });
    assert.equal(mail.actionUrl, link);
    assert.equal(mail.firstName, 'Ravi');
    assert.match(mail.message, /40 posts in 4 communities/);
    subjects.add(mail.subject);
  });
  assert.equal(subjects.size, 4);
  assert.match(unverified.buildEmail('verify-4', unverifiedUser(200), { link, appUrl: 'x' }).note, /not send any more reminders/i);
});

test('the confirm page renders a POST button only', async () => {
  const html = await ejs.renderFile(path.join(views, 'pages/verify-link.ejs'), { icon, csrfToken: 'tok', title: 'Confirm', firstName: 'Ravi', action: '/auth/verify-email/u9/abc', flash: null, currentUser: null, appUrl: 'http://x', gifsEnabled: false, pagePath: '/auth/verify-email', noIndex: true });
  assert.match(html, /method="post" action="\/auth\/verify-email\/u9\/abc"/);
  assert.match(html, /Confirm my email/);
});

// ------------------------------------------------------------------ security
test('operator injection keys are stripped from body, query and nested values', () => {
  const body = { email: 'a@b.c', token: { $gt: '' }, list: [{ $where: '1' }, { ok: 1 }], nested: { 'a.b': 1, fine: 2 } };
  clean(body);
  assert.deepEqual(body, { email: 'a@b.c', token: {}, list: [{}, { ok: 1 }], nested: { fine: 2 } });
  assert.equal(clean('plain'), 'plain');
  assert.equal(clean(null), null);
});

test('password policy rejects short, long, common and personal passwords', () => {
  assert.match(passwordProblem('short'), /at least 8/);
  assert.match(passwordProblem('x'.repeat(200)), /at most/);
  assert.match(passwordProblem('password123'), /too easy/);
  assert.match(passwordProblem('aaaaaaaaaaaa'), /too easy/);
  assert.match(passwordProblem('ravikumar2026!', { email: 'ravikumar@x.com' }), /email/);
  assert.match(passwordProblem(undefined), /at least 8/);
  assert.equal(passwordProblem('correct horse battery staple', { email: 'a@b.c', name: 'Ravi Kumar' }), '');
});

test('in production a missing SESSION_SECRET never falls back to the public development secret', () => {
  const { sessionSecret } = require('../src/utils/secrets');
  const saved = { secret: process.env.SESSION_SECRET, env: process.env.NODE_ENV };
  try {
    delete process.env.SESSION_SECRET;
    process.env.NODE_ENV = 'production';
    const secret = sessionSecret();
    assert.notEqual(secret, 'crowdwide-development-secret');
    assert.ok(secret.length >= 64);
    assert.equal(sessionSecret(), secret, 'stable for the life of the process');
    process.env.SESSION_SECRET = 'configured';
    assert.equal(sessionSecret(), 'configured');
    process.env.NODE_ENV = 'test';
    delete process.env.SESSION_SECRET;
    assert.equal(sessionSecret(), 'crowdwide-development-secret');
  } finally {
    if (saved.secret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = saved.secret;
    process.env.NODE_ENV = saved.env;
  }
});
