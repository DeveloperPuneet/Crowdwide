// First-reply email, welcome series, streaks/badges and the weekly top page.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');

process.env.NODE_ENV = 'test';
process.env.APP_URL = 'https://app.example.com';
delete process.env.REENGAGEMENT_ENABLED;

const feedService = require('../src/services/feedService');
feedService.getInterestProfile = async () => ({ interests: new Map(), authorAffinity: new Map() });
const communityRecs = require('../src/services/communityRecommendations');
let recommended = [];
communityRecs.getRecommendedCommunities = async () => recommended;
const mailer = require('../src/services/mailer');
const emails = [];
let emailResult = true;
mailer.sendLifecycleEmail = async (user, content) => { emails.push({ user, content }); return emailResult; };
const push = require('../src/services/push');
const pushes = [];
push.sendPushToUser = async (id, payload) => { pushes.push({ id, payload }); };

const User = require('../src/models/User');
const Post = require('../src/models/Post');
const Comment = require('../src/models/Comment');
const Notification = require('../src/models/Notification');
const ReengagementLog = require('../src/models/ReengagementLog');
const SiteSetting = require('../src/models/SiteSetting');
const siteConfig = require('../src/services/siteConfig');

const state = { users: [], found: null, updates: [], logs: [], notifications: [], counts: { posts: 0, comments: 0 }, welcomeEnabled: true, claimOk: true };
User.find = () => { const chain = { select: () => chain, sort: () => chain, limit: () => chain, lean: async () => state.users }; return chain; };
User.findById = () => { const chain = { select: () => chain, lean: async () => state.found }; return chain; };
User.updateOne = async (filter, update) => { state.updates.push({ filter, update }); return { modifiedCount: state.claimOk ? 1 : 0 }; };
Post.countDocuments = async () => state.counts.posts;
Post.aggregate = async () => [{ total: 7 }];
Post.findById = () => { const chain = { select: () => chain, lean: async () => ({ body: 'My very first post about gardening', type: 'post' }) }; return chain; };
Comment.countDocuments = async () => state.counts.comments;
Notification.create = async (doc) => { state.notifications.push(doc); return doc; };
ReengagementLog.countDocuments = async () => 0;
ReengagementLog.create = async (doc) => { state.logs.push(doc); return doc; };
SiteSetting.getSingleton = async () => ({ welcomeEnabled: true, welcomeEmailsEnabled: state.welcomeEnabled });

const lifecycle = require('../src/services/lifecycle');
const streaks = require('../src/services/streaks');
const { badgesFor, BADGES } = require('../src/utils/badges');
const { rankWeekly } = require('../src/services/weeklyTop');
const { signToken, verifyToken } = require('../src/utils/unsubscribeToken');

const HOUR = 3600000;
const DAY = 24 * HOUR;
const NOON = new Date('2026-10-14T12:00:00Z');
const oid = (n) => String(n).padStart(24, 'b');
function reset() {
  emails.length = 0; pushes.length = 0; emailResult = true; recommended = [];
  Object.assign(state, { users: [], found: null, updates: [], logs: [], notifications: [], counts: { posts: 0, comments: 0 }, welcomeEnabled: true, claimOk: true });
  siteConfig.clearSiteConfigCache();
}
const member = (overrides = {}) => ({ _id: oid(1), name: 'Ravi Kumar', email: 'ravi@example.com', isVerified: true, timezone: 'UTC', createdAt: new Date(NOON - 40 * HOUR), welcome: {}, notificationPreferences: {}, joinedCommunities: [], following: [], streak: {}, badges: [], ...overrides });

// ---------------------------------------------------------------- first reply
test('a new member gets one email for their first reply, plus the badge, and never a second', async () => {
  reset();
  state.found = member({ createdAt: new Date(NOON - 3 * DAY) });
  const result = await lifecycle.handleReplyReceived({ postId: oid(5), postAuthorId: oid(1), replierId: oid(2), replierName: 'Meera', replyText: 'Love this!', now: NOON });
  assert.equal(result.sent, true);
  assert.equal(emails.length, 1);
  assert.equal(emails[0].content.subject, 'Meera replied to your post');
  assert.equal(emails[0].content.quote.text, 'Love this!');
  assert.match(emails[0].content.unsubscribeUrl, /unsubscribe\/welcome\//);
  assert.ok(state.updates.some((u) => u.update.$push?.badges?.key === 'first-reply'));
  assert.equal(state.logs[0].stage, 'first-reply');

  reset();
  state.found = member({ firstReplyAt: new Date(NOON - DAY) });
  assert.equal((await lifecycle.handleReplyReceived({ postId: oid(5), postAuthorId: oid(1), replierId: oid(2), now: NOON })).reason, 'not-first');
  assert.equal(emails.length, 0);
});

test('first-reply email is skipped for old accounts, opted-out members, blocked repliers and self-replies, but the badge is still awarded', async () => {
  for (const found of [member({ createdAt: new Date(NOON - 90 * DAY) }), member({ notificationPreferences: { emailWelcome: false } }), member({ blockedUsers: [oid(2)] })]) {
    reset();
    state.found = found;
    const result = await lifecycle.handleReplyReceived({ postId: oid(5), postAuthorId: oid(1), replierId: oid(2), now: NOON });
    assert.equal(result.sent, false);
    assert.equal(emails.length, 0);
    assert.ok(state.updates.some((u) => u.update.$push?.badges?.key === 'first-reply'));
  }
  reset();
  assert.equal((await lifecycle.handleReplyReceived({ postId: oid(5), postAuthorId: oid(1), replierId: oid(1), now: NOON })).reason, 'self');
});

test('a failed first-reply email releases the claim', async () => {
  reset(); emailResult = false;
  state.found = member();
  const result = await lifecycle.handleReplyReceived({ postId: oid(5), postAuthorId: oid(1), replierId: oid(2), now: NOON });
  assert.equal(result.reason, 'mail-failed');
  assert.ok(state.updates.some((u) => u.update.$unset?.firstReplyEmailSentAt));
});

// -------------------------------------------------------------- welcome series
test('welcome stages open at day 0, 2, 4 and 6 and respect gaps, preferences and daytime', () => {
  const at = (hours) => ({ ...member(), createdAt: new Date(NOON - hours * HOUR) });
  assert.equal(lifecycle.dueWelcomeStage(at(1), NOON), null);
  assert.equal(lifecycle.dueWelcomeStage(at(5), NOON).id, 'welcome-1');
  assert.equal(lifecycle.dueWelcomeStage(at(50), NOON).id, 'welcome-2');
  assert.equal(lifecycle.dueWelcomeStage(at(100), NOON).id, 'welcome-3');
  assert.equal(lifecycle.dueWelcomeStage(at(150), NOON).id, 'welcome-4');
  assert.equal(lifecycle.dueWelcomeStage(at(250), NOON), null);
  assert.equal(lifecycle.dueWelcomeStage({ ...at(50), welcome: { sent: ['welcome-2'] } }, NOON), null);
  assert.equal(lifecycle.dueWelcomeStage({ ...at(50), welcome: { sent: ['welcome-1'], lastSentAt: new Date(NOON - 5 * HOUR) } }, NOON), null, 'gap');
  assert.equal(lifecycle.dueWelcomeStage({ ...at(50), notificationPreferences: { emailWelcome: false } }, NOON), null);
  const night = new Date('2026-10-14T03:00:00Z');
  assert.equal(lifecycle.dueWelcomeStage({ ...member(), createdAt: new Date(night - 50 * HOUR) }, night), null);
});

test('welcome emails adapt to what the member has done and skip what is pointless', () => {
  const one = lifecycle.buildWelcome('welcome-1', member(), { posts: 0, joined: 0, following: 0 }, NOON);
  assert.equal(one.steps.length, 3);
  assert.equal(one.actionLabel, 'Find communities');
  const done = lifecycle.buildWelcome('welcome-1', member(), { posts: 2, joined: 3, following: 4 }, NOON);
  assert.ok(done.steps.every((step) => step.startsWith('Done')));
  assert.equal(lifecycle.buildWelcome('welcome-2', member(), { posts: 1 }, NOON).skip, true);
  assert.match(lifecycle.buildWelcome('welcome-2', member(), { posts: 0 }, NOON).actionUrl, /ask=qotd/);
  assert.equal(lifecycle.buildWelcome('welcome-3', member(), { joined: 3, communities: [{ name: 'x' }] }, NOON).skip, true);
  assert.equal(lifecycle.buildWelcome('welcome-3', member(), { joined: 0, communities: [] }, NOON).skip, true);
  const three = lifecycle.buildWelcome('welcome-3', member(), { joined: 0, communities: [{ name: 'Poets', slug: 'poets', description: 'Verse', membersCount: 1 }] }, NOON);
  assert.equal(three.items[0].url, 'https://app.example.com/communities/poets');
  const four = lifecycle.buildWelcome('welcome-4', member(), { posts: 2, comments: 3, likesReceived: 9, longest: 4, badges: ['first-post'] }, NOON);
  assert.match(four.message, /First post/);
  assert.match(four.message, /\/top/);
  assert.equal(four.details.length, 4);
});

test('the welcome sender emails a due member once, logs it, and marks skipped stages without emailing', async () => {
  reset();
  state.users = [member({ createdAt: new Date(NOON - 5 * HOUR) })];
  const result = await lifecycle.sendWelcomeEmails({ now: NOON });
  assert.equal(result.sent, 1);
  assert.equal(emails[0].content.label, 'Welcome email (welcome-1)');
  assert.equal(state.logs[0].stage, 'welcome-1');
  assert.deepEqual(state.updates[0].update.$addToSet, { 'welcome.sent': 'welcome-1' });

  reset();
  state.users = [member({ createdAt: new Date(NOON - 50 * HOUR), welcome: { sent: ['welcome-1'], lastSentAt: new Date(NOON - 40 * HOUR) } })];
  state.counts.posts = 3;
  const skipped = await lifecycle.sendWelcomeEmails({ now: NOON });
  assert.equal(skipped.skipped, 1);
  assert.equal(emails.length, 0);

  reset();
  state.welcomeEnabled = false;
  state.users = [member({ createdAt: new Date(NOON - 5 * HOUR) })];
  assert.equal((await lifecycle.sendWelcomeEmails({ now: NOON })).disabled, true);

  reset(); emailResult = false;
  state.users = [member({ createdAt: new Date(NOON - 5 * HOUR) })];
  assert.equal((await lifecycle.sendWelcomeEmails({ now: NOON })).sent, 0);
  assert.ok(state.updates.some((u) => u.update.$pull?.['welcome.sent'] === 'welcome-1'));
});

test('re-engagement leaves first-week members to the welcome series', () => {
  const reengagement = require('../src/services/reengagement');
  const user = { ...member(), lastActiveAt: new Date(NOON - 30 * HOUR), reengagement: {}, createdAt: new Date(NOON - 3 * DAY) };
  assert.equal(reengagement.dueStage(user, NOON), null);
  assert.equal(reengagement.dueStage({ ...user, createdAt: new Date(NOON - 20 * DAY) }, NOON).id, 'question');
});

test('welcome unsubscribe tokens are separate from reminder tokens', () => {
  const token = signToken('welcome', oid(1));
  assert.equal(verifyToken('welcome', oid(1), token), true);
  assert.equal(verifyToken('reminders', oid(1), token), false);
  assert.equal(verifyToken('other', oid(1), token), false);
});

// ------------------------------------------------------------ streaks + badges
test('streaks grow day by day on the member\'s own clock and reset after a missed day', () => {
  assert.equal(streaks.dayKey(new Date('2026-10-14T20:00:00Z'), 'Asia/Kolkata'), '2026-10-15');
  assert.equal(streaks.dayKey(new Date('2026-10-14T20:00:00Z'), 'UTC'), '2026-10-14');
  assert.equal(streaks.previousDayKey('2026-03-01'), '2026-02-28');
  assert.deepEqual(streaks.nextStreak({}, '2026-10-14'), { current: 1, longest: 1, lastDay: '2026-10-14', changed: true });
  assert.equal(streaks.nextStreak({ current: 2, longest: 5, lastDay: '2026-10-13' }, '2026-10-14').current, 3);
  assert.equal(streaks.nextStreak({ current: 2, longest: 5, lastDay: '2026-10-13' }, '2026-10-14').longest, 5);
  assert.equal(streaks.nextStreak({ current: 9, longest: 9, lastDay: '2026-10-10' }, '2026-10-14').current, 1);
  assert.equal(streaks.nextStreak({ current: 4, longest: 4, lastDay: '2026-10-14' }, '2026-10-14').changed, false);
});

test('a streak stays visible until the end of the day after the last contribution', () => {
  const now = new Date('2026-10-14T12:00:00Z');
  assert.deepEqual(streaks.effectiveStreak({ current: 4, longest: 6, lastDay: '2026-10-14' }, now, 'UTC'), { current: 4, longest: 6, doneToday: true, atRisk: false });
  assert.deepEqual(streaks.effectiveStreak({ current: 4, longest: 6, lastDay: '2026-10-13' }, now, 'UTC'), { current: 4, longest: 6, doneToday: false, atRisk: true });
  assert.equal(streaks.effectiveStreak({ current: 4, longest: 6, lastDay: '2026-10-11' }, now, 'UTC').current, 0);
});

test('badge rules', () => {
  assert.deepEqual(badgesFor({ streak: 7, posts: 1, comments: null }).sort(), ['first-post', 'streak-3', 'streak-7']);
  assert.deepEqual(badgesFor({ streak: 1, posts: null, comments: 25 }).sort(), ['comments-25', 'first-comment']);
  assert.ok(badgesFor({ streak: 1, posts: 10, answeredQotd: true }).includes('qotd'));
  assert.equal(new Set(BADGES.map((badge) => badge.key)).size, BADGES.length);
});

test('recordContribution extends the streak, awards new badges once and notifies', async () => {
  reset();
  state.found = member({ streak: { current: 2, longest: 2, lastDay: '2026-10-13' }, badges: [{ key: 'first-post' }] });
  state.counts.posts = 10;
  const result = await streaks.recordContribution(oid(1), { kind: 'post', hashtags: ['qotd'], now: NOON });
  assert.equal(result.streak, 3);
  assert.deepEqual(result.earned.sort(), ['posts-10', 'qotd', 'streak-3']);
  assert.equal(state.notifications.length, 3);
  assert.equal(state.notifications[0].type, 'badge');
  const streakWrite = state.updates.find((u) => u.update.$set?.['streak.current']);
  assert.equal(streakWrite.update.$set['streak.lastDay'], '2026-10-14');
});

test('streak savers push once, only in the local evening, only for a live streak that is not done today', async () => {
  reset();
  const evening = new Date('2026-10-14T19:00:00Z');
  state.users = [
    member({ _id: oid(1), pushNotificationsEnabled: true, streak: { current: 5, longest: 5, lastDay: '2026-10-13' } }),
    member({ _id: oid(2), pushNotificationsEnabled: true, streak: { current: 5, longest: 5, lastDay: '2026-10-14' } }),
    member({ _id: oid(3), pushNotificationsEnabled: true, streak: { current: 5, longest: 5, lastDay: '2026-10-13', saverSentDay: '2026-10-14' } })
  ];
  const result = await streaks.sendStreakSavers({ now: evening });
  assert.equal(result.sent, 1);
  assert.match(pushes[0].payload.body, /5-day streak/);
  reset();
  state.users = [member({ pushNotificationsEnabled: true, streak: { current: 5, longest: 5, lastDay: '2026-10-13' } })];
  assert.equal((await streaks.sendStreakSavers({ now: NOON })).sent, 0, 'noon is not evening');
});

// --------------------------------------------------------------- weekly top
test('weekly top ranks public posts, never repeats one across sections and skips private authors', () => {
  const author = (n, extra = {}) => ({ _id: oid(100 + n), name: `Author ${n}`, ...extra });
  const post = (n, o = {}) => ({ _id: oid(n), author: author(n % 4), type: 'post', body: `Post ${n}`, createdAt: new Date(NOON - HOUR), likes: [], commentsCount: 0, ...o });
  const posts = [
    post(1, { likes: [1, 2, 3, 4, 5], commentsCount: 4 }),
    post(2, { type: 'article', likes: [1, 2], commentsCount: 1 }),
    post(3, { commentsCount: 9 }),
    post(4, { author: author(9, { privacy: 'followers' }), likes: [1, 2, 3, 4, 5, 6, 7, 8, 9] }),
    post(5, { replyTo: oid(1), likes: [1, 2, 3] }),
    post(6, { community: { _id: oid(50), name: 'Poets', slug: 'poets', isPrivate: false }, likes: [1] })
  ];
  const ranked = rankWeekly(posts, { now: NOON.getTime() });
  const all = [...ranked.top, ...ranked.articles, ...ranked.discussed].map((p) => p._id);
  assert.equal(new Set(all).size, all.length, 'no post appears twice');
  assert.ok(!all.includes(oid(4)) && !all.includes(oid(5)));
  assert.equal(ranked.articles[0]._id, oid(2));
  assert.equal(ranked.communities[0].community.slug, 'poets');
  assert.equal(ranked.totals.posts, 4);
});

test('the weekly top page renders with and without content', async () => {
  const views = path.join(__dirname, '..', 'src', 'views');
  const helpers = { icon: () => '', csrfToken: 't', cspNonce: 'n', appUrl: 'https://app.example.com', currentUser: null, flash: null, partners: [], renderRichBody: (v) => v, renderMentions: (v) => v, renderInlineText: (v) => v, plainText: (v) => v, preview: (v) => v, gifsEnabled: false, isStaging: false };
  const base = { ...helpers, title: 'This week on Crowdwide', description: 'd', pagePath: '/top', canonicalUrl: 'https://app.example.com/top', shareUrl: 'https://app.example.com/top', shareText: 't', range: 'Oct 7 - Oct 14', structuredData: {}, top: [], articles: [], discussed: [], creators: [], communities: [], totals: { posts: 0, members: 0, communities: 0 } };
  const empty = await ejs.renderFile(path.join(views, 'pages', 'top.ejs'), base, { views: [views] });
  assert.match(empty, /A quiet week so far/);
  assert.match(empty, /data-copy-link/);
  const full = await ejs.renderFile(path.join(views, 'pages', 'top.ejs'), { ...base, creators: [{ author: { _id: oid(1), name: 'Asha' }, posts: 2 }], communities: [{ community: { slug: 'poets', name: 'Poets', membersCount: 3 }, posts: 4 }] }, { views: [views] });
  assert.match(full, /Creators to watch/);
  assert.match(full, /Communities on the rise/);
});

test('new preferences and notification types exist and default on', () => {
  assert.equal(User.schema.path('notificationPreferences.emailWelcome').defaultValue, true);
  assert.equal(SiteSetting.schema.path('welcomeEmailsEnabled').defaultValue, true);
  assert.ok(Notification.schema.path('type').enumValues.includes('badge'));
  assert.ok(ReengagementLog.schema.path('stage').enumValues.includes('first-reply'));
});
