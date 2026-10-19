// Come-back reminders: stage windows, per-spell bookkeeping, content picking,
// sending/claiming/rollback, daily cap, activity tracking, unsubscribe links
// and the Question of the Day.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');

process.env.NODE_ENV = 'test';
process.env.APP_URL = 'https://app.example.com';
delete process.env.REENGAGEMENT_ENABLED;
delete process.env.REENGAGEMENT_DAILY_LIMIT;
delete process.env.NEWSLETTER_TIMEZONE;

// ---- stubs installed BEFORE the service is loaded -------------------------------
const feedService = require('../src/services/feedService');
feedService.getInterestProfile = async () => ({ interests: new Map([['makers', 1]]), authorAffinity: new Map() });
const mailer = require('../src/services/mailer');
const emails = [];
let emailResult = true;
mailer.sendReengagementEmail = async (user, reminder) => { emails.push({ user, reminder }); return emailResult; };
const push = require('../src/services/push');
const pushes = [];
push.sendPushToUser = async (id, payload) => { pushes.push({ id, payload }); };

const User = require('../src/models/User');
const Post = require('../src/models/Post');
const Community = require('../src/models/Community');
const Notification = require('../src/models/Notification');
const ReengagementLog = require('../src/models/ReengagementLog');
const SiteSetting = require('../src/models/SiteSetting');
const siteConfig = require('../src/services/siteConfig');

const state = { users: [], posts: [], updates: [], logs: [], notifications: [], sentToday: 0, reengagementEnabled: true };
User.find = () => { const chain = { select: () => chain, sort: () => chain, limit: () => chain, lean: async () => state.users }; return chain; };
User.countDocuments = async () => 3;
User.updateOne = async (filter, update) => { state.updates.push({ filter, update }); return { modifiedCount: 1 }; };
Post.find = () => { const chain = { sort: () => chain, limit: () => chain, populate: () => chain, lean: async () => state.posts }; return chain; };
Post.countDocuments = async () => 12;
Community.countDocuments = async () => 2;
Notification.create = async (doc) => { state.notifications.push(doc); return doc; };
Notification.find = () => { const chain = { select: () => chain, limit: () => chain, lean: async () => [{ type: 'comment' }, { type: 'comment' }, { type: 'like' }, { type: 'follow' }] }; return chain; };
ReengagementLog.countDocuments = async () => state.sentToday;
ReengagementLog.create = async (doc) => { state.logs.push(doc); return doc; };
SiteSetting.getSingleton = async () => ({ reengagementEnabled: state.reengagementEnabled });

const service = require('../src/services/reengagement');
const { signReminderToken, verifyReminderToken, reminderUnsubscribeUrl } = require('../src/utils/unsubscribeToken');
const { questionOfTheDay, QUESTIONS, answerPrefill, startOfDay } = require('../src/utils/questions');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// 12:00 UTC on a Wednesday: inside everybody's "daytime" for UTC members.
const NOON = new Date('2026-10-14T12:00:00Z');
const ago = (ms, from = NOON) => new Date(from.getTime() - ms);
const oid = (n) => String(n).padStart(24, 'a');

function reset() {
  emails.length = 0; pushes.length = 0; emailResult = true;
  state.users = []; state.posts = []; state.updates = []; state.logs = []; state.notifications = []; state.sentToday = 0; state.reengagementEnabled = true;
  siteConfig.clearSiteConfigCache();
}
const member = (overrides = {}) => ({ _id: oid(1), name: 'Asha Rao', email: 'asha@example.com', timezone: 'UTC', lastActiveAt: ago(30 * HOUR), reengagement: {}, joinedCommunities: [], following: [], notificationPreferences: {}, ...overrides });
const post = (id, overrides = {}) => ({ _id: oid(id), author: { _id: oid(900 + id), name: `Writer ${id}` }, body: `Post number ${id}`, createdAt: ago(6 * HOUR), hashtags: [], likes: [], commentsCount: 0, ...overrides });

// ------------------------------------------------------------------ stage rules

test('stages open at 24 hours, 3 days and 7 days and each is sent once per away-spell', () => {
  assert.equal(service.stageFor(23 * HOUR), null);
  assert.equal(service.stageFor(30 * HOUR).id, 'question');
  assert.equal(service.stageFor(71 * HOUR).id, 'question');
  assert.equal(service.stageFor(80 * HOUR).id, 'discussion');
  assert.equal(service.stageFor(6 * DAY).id, 'discussion');
  assert.equal(service.stageFor(8 * DAY).id, 'winback');
  assert.equal(service.stageFor(46 * DAY), null, 'long-gone members are left alone');
  assert.equal(service.stageFor(30 * HOUR, ['question']), null, 'question already sent');
  assert.equal(service.stageFor(5 * DAY, ['question']).id, 'discussion');
});

test('a visit after the last reminder starts a fresh away-spell', () => {
  const sentAt = ago(2 * DAY);
  assert.deepEqual(service.currentSpellSent({ reengagement: { sent: ['question'], lastSentAt: sentAt }, lastActiveAt: ago(3 * DAY) }), ['question']);
  assert.deepEqual(service.currentSpellSent({ reengagement: { sent: ['question'], lastSentAt: sentAt }, lastActiveAt: ago(1 * DAY) }), []);
  assert.deepEqual(service.currentSpellSent({ reengagement: {} , lastActiveAt: ago(1 * DAY) }), []);
});

test('dueStage honours the member setting, suspension, the minimum gap and local daytime', () => {
  assert.equal(service.dueStage(member(), NOON).id, 'question');
  assert.equal(service.dueStage(member({ notificationPreferences: { emailReminders: false } }), NOON), null);
  assert.equal(service.dueStage(member({ suspendedUntil: new Date(NOON.getTime() + DAY) }), NOON), null);
  assert.equal(service.dueStage(member({ lastActiveAt: ago(5 * DAY), reengagement: { sent: ['question'], lastSentAt: ago(10 * HOUR) } }), NOON), null, 'under 40h since the previous reminder');
  assert.equal(service.dueStage(member({ lastActiveAt: ago(5 * DAY), reengagement: { sent: ['question'], lastSentAt: ago(2 * DAY) } }), NOON).id, 'discussion');
  assert.equal(service.dueStage(member({ lastActiveAt: undefined }), NOON), null);
  const threeAmUtc = new Date('2026-10-14T03:00:00Z');
  assert.equal(service.dueStage(member({ lastActiveAt: ago(30 * HOUR, threeAmUtc) }), threeAmUtc), null, '03:00 is night time for a UTC member');
  const tenThirtyIst = new Date('2026-10-14T05:00:00Z');
  assert.equal(service.dueStage(member({ timezone: 'Asia/Kolkata', lastActiveAt: ago(30 * HOUR, tenThirtyIst) }), tenThirtyIst).id, 'question', '10:30 in Kolkata is daytime');
  assert.equal(service.dueStage(member({ timezone: 'Asia/Kolkata', lastActiveAt: ago(30 * HOUR, threeAmUtc) }), threeAmUtc), null, '08:30 in Kolkata is still too early');
});

// --------------------------------------------------------------- content picking

test('question picking prefers unanswered questions that match interests and skips own, private and already-sent posts', () => {
  const user = member({ joinedCommunities: [oid(70)], reengagement: { sentPosts: [oid(4)] } });
  const posts = [
    post(1, { body: 'What are you building this month?', hashtags: ['makers'], commentsCount: 0 }),
    post(2, { body: 'Is anyone else learning Rust?', hashtags: [], commentsCount: 9 }),
    post(3, { body: 'Just a statement, no question' }),
    post(4, { body: 'Already emailed this question?' }),
    post(5, { body: 'My own question?', author: { _id: user._id, name: 'Me' } }),
    post(6, { body: 'Secret club question?', community: { _id: oid(71), isPrivate: true } }),
    post(7, { type: 'poll', body: '', poll: { question: 'Tabs or spaces?' }, community: { _id: oid(70), isPrivate: false } })
  ];
  const picked = service.pickQuestions(posts, user, new Map([['makers', 1]]), NOON.getTime(), 3).map((p) => p._id);
  assert.deepEqual(picked.slice(0, 2), [oid(1), oid(7)]);
  assert.ok(!picked.includes(oid(3)) && !picked.includes(oid(4)) && !picked.includes(oid(5)) && !picked.includes(oid(6)));
});

test('discussion picking needs real conversation and recent activity', () => {
  const posts = [
    post(1, { commentsCount: 6, likes: [1, 2, 3] }),
    post(2, { commentsCount: 0, likes: [] }),
    post(3, { commentsCount: 4, createdAt: ago(20 * DAY) }),
    post(4, { commentsCount: 3, likes: [1] })
  ];
  const picked = service.pickDiscussions(posts, member(), new Map(), NOON.getTime()).map((p) => p._id);
  assert.deepEqual(picked, [oid(1), oid(4)]);
});

test('question reminder uses a community question when one exists, otherwise the Question of the Day', () => {
  const withQuestion = service.buildReminder('question', member(), { posts: [post(1, { body: 'What are you reading?', community: { name: 'Bookworms', _id: oid(5) } })], now: NOON.getTime() });
  assert.equal(withQuestion.eyebrow, 'A QUESTION FOR YOU');
  assert.match(withQuestion.subject, /Writer 1 asked/);
  assert.equal(withQuestion.actionUrl, `https://app.example.com/posts/${oid(1)}`);
  assert.deepEqual(withQuestion.sentPostIds, [oid(1)]);
  assert.match(withQuestion.unsubscribeUrl, /^https:\/\/app\.example\.com\/unsubscribe\/reminders\/a{23}1\/[a-f0-9]{32}$/);

  const fallback = service.buildReminder('question', member(), { posts: [], now: NOON.getTime() });
  assert.equal(fallback.question.text, questionOfTheDay(NOON).text);
  assert.equal(fallback.actionUrl, 'https://app.example.com/dashboard?ask=qotd');
});

test('discussion and win-back reminders say nothing rather than send filler', () => {
  assert.equal(service.buildReminder('discussion', member(), { posts: [post(1)], now: NOON.getTime() }), null);
  assert.equal(service.buildReminder('winback', member(), { posts: [], missed: { likes: 0, comments: 0, follows: 0, mentions: 0 }, now: NOON.getTime() }), null);
  const discussion = service.buildReminder('discussion', member(), { posts: [post(1, { commentsCount: 5 })], pulse: { posts: 12, members: 3, communities: 2 }, now: NOON.getTime() });
  assert.equal(discussion.stats.length, 2);
  const winback = service.buildReminder('winback', member(), { posts: [post(1, { hashtags: ['makers'], likes: [1, 2] })], interests: new Map([['makers', 1]]), missed: { likes: 1, comments: 2, follows: 1, mentions: 0 }, now: NOON.getTime() });
  assert.match(winback.subject, /4 things happened/);
  assert.ok(winback.stats.some((row) => row.label === 'Replies'));
  assert.match(winback.note, /last reminder/);
});

// -------------------------------------------------------------------- the sender

test('a due member gets one reminder by email, in-app and push; the claim, log and sent posts are recorded', async () => {
  reset();
  state.users = [member({ pushNotificationsEnabled: true })];
  state.posts = [post(1, { body: 'What are you building?', hashtags: ['makers'] })];
  const result = await service.sendReengagementReminders({ now: NOON });
  assert.equal(result.sent, 1);
  assert.equal(result.byStage.question, 1);
  assert.equal(emails.length, 1);
  assert.equal(emails[0].reminder.stage, 'question');
  assert.equal(state.notifications[0].type, 'reminder');
  assert.equal(pushes.length, 1);
  assert.deepEqual(state.logs[0].channels, ['email', 'in-app', 'push']);
  const claim = state.updates[0];
  assert.deepEqual(claim.update.$set['reengagement.sent'], ['question']);
  assert.equal(claim.filter.lastActiveAt.getTime(), state.users[0].lastActiveAt.getTime(), 'claim fails if the member just came back');
  assert.ok(state.updates.some((entry) => entry.update.$push?.['reengagement.sentPosts']));
});

test('members without push only get email and an in-app note', async () => {
  reset();
  state.users = [member()];
  await service.sendReengagementReminders({ now: NOON });
  assert.equal(pushes.length, 0);
  assert.deepEqual(state.logs[0].channels, ['email', 'in-app']);
});

test('a failed email releases the claim so the member is retried on the next tick', async () => {
  reset();
  emailResult = false;
  state.users = [member({ reengagement: { sent: [] } })];
  const result = await service.sendReengagementReminders({ now: NOON });
  assert.equal(result.sent, 0);
  assert.equal(state.logs.length, 0);
  assert.equal(state.notifications.length, 0);
  const rollback = state.updates[state.updates.length - 1];
  assert.ok(rollback.update.$unset?.['reengagement.lastSentAt']);
});

test('the master switches, the daily cap and the per-tick limit all stop sending', async () => {
  reset();
  state.users = [member()];
  state.reengagementEnabled = false;
  assert.equal((await service.sendReengagementReminders({ now: NOON })).disabled, true);
  assert.equal(emails.length, 0);

  reset();
  process.env.REENGAGEMENT_ENABLED = 'off';
  state.users = [member()];
  assert.equal((await service.sendReengagementReminders({ now: NOON })).disabled, true);
  delete process.env.REENGAGEMENT_ENABLED;

  reset();
  process.env.REENGAGEMENT_DAILY_LIMIT = '5';
  state.sentToday = 5;
  state.users = [member()];
  assert.equal((await service.sendReengagementReminders({ now: NOON })).sent, 0);
  delete process.env.REENGAGEMENT_DAILY_LIMIT;

  reset();
  state.users = [member({ _id: oid(1) }), member({ _id: oid(2), email: 'b@example.com' }), member({ _id: oid(3), email: 'c@example.com' })];
  assert.equal((await service.sendReengagementReminders({ now: NOON, limit: 2 })).sent, 2);
});

test('dry run only counts who is due', async () => {
  reset();
  state.users = [member()];
  const result = await service.sendReengagementReminders({ now: NOON, dryRun: true });
  assert.equal(result.due, 1);
  assert.equal(emails.length, 0);
  assert.equal(state.updates.length, 0);
});

// ------------------------------------------------------------ activity tracking

test('recordActivity notes a long absence for the welcome-back card and credits a reminder that worked', async () => {
  const calls = { logs: [] };
  User.findOneAndUpdate = () => ({ lean: async () => ({ lastActiveAt: ago(3 * DAY), reengagement: { lastSentAt: ago(1 * DAY) } }) });
  ReengagementLog.findOneAndUpdate = async (filter, update) => { calls.logs.push({ filter, update }); return null; };
  const session = {};
  await service.recordActivity(oid(1), session, NOON);
  assert.equal(session.awayFrom, ago(3 * DAY).toISOString());
  assert.equal(calls.logs.length, 1);
  assert.deepEqual(calls.logs[0].filter, { user: oid(1), returnedAt: null });

  User.findOneAndUpdate = () => ({ lean: async () => ({ lastActiveAt: ago(2 * HOUR) }) });
  const quick = {};
  await service.recordActivity(oid(1), quick, NOON);
  assert.equal(quick.awayFrom, undefined, 'a short gap shows no welcome-back card');
});

// --------------------------------------------------------- unsubscribe + emails

test('unsubscribe tokens are signed per member and cannot be forged or reused', () => {
  const token = signReminderToken(oid(1));
  assert.equal(token.length, 32);
  assert.equal(verifyReminderToken(oid(1), token), true);
  assert.equal(verifyReminderToken(oid(2), token), false);
  assert.equal(verifyReminderToken(oid(1), token.slice(0, 31) + (token.endsWith('0') ? '1' : '0')), false);
  assert.equal(verifyReminderToken(oid(1), ''), false);
  assert.equal(reminderUnsubscribeUrl('https://x.test/', oid(1)), `https://x.test/unsubscribe/reminders/${oid(1)}/${token}`);
});

test('the unsubscribe route flips the preference and rejects bad tokens', async () => {
  const controller = require('../src/controllers/growthController');
  const updates = [];
  User.updateOne = async (filter, update) => { updates.push({ filter, update }); return { modifiedCount: 1 }; };
  const rendered = [];
  const res = { status(code) { this.code = code; return this; }, render(view, data) { rendered.push({ view, data, code: this.code }); } };
  const id = oid(1);
  await controller.unsubscribe({ params: { kind: 'reminders', id, token: 'f'.repeat(32) } }, res);
  assert.equal(rendered[0].data.state, 'invalid');
  assert.equal(updates.length, 0);
  await controller.unsubscribe({ params: { kind: 'reminders', id, token: signReminderToken(id) } }, res);
  assert.equal(rendered[1].data.state, 'done');
  assert.deepEqual(updates[0].update, { $set: { 'notificationPreferences.emailReminders': false } });
});

test('the reminder email carries a one-click unsubscribe link and header', async (t) => {
  process.env.MAIL_HOST = 'smtp.example.com'; process.env.MAIL_PORT = '587'; process.env.MAIL_USER = 'u'; process.env.MAIL_PASS = 'p';
  delete process.env.MAIL_PROVIDER;
  delete require.cache[require.resolve('../src/services/mailer')];
  const nodemailer = require('nodemailer');
  const sent = [];
  t.mock.method(nodemailer, 'createTransport', () => ({ sendMail: (mail) => { sent.push(mail); return Promise.resolve(); } }));
  const realMailer = require('../src/services/mailer');
  const reminder = service.buildReminder('question', member(), { posts: [post(1, { body: 'What are you reading?' })], now: NOON.getTime() });
  assert.equal(await realMailer.sendReengagementEmail(member(), reminder), true);
  assert.match(sent[0].headers['List-Unsubscribe'], /unsubscribe\/reminders\/a{23}1\//);
  assert.equal(sent[0].headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.match(sent[0].html, /Stop these reminders/);
  assert.match(sent[0].html, /Share your answer/);
  assert.match(sent[0].text, /unsubscribe\/reminders/);
});

// ------------------------------------------------------ settings, models, views

test('reminders default on, can be switched off, and the Notification type exists', () => {
  assert.equal(User.schema.path('notificationPreferences.emailReminders').defaultValue, true);
  assert.equal(SiteSetting.schema.path('reengagementEnabled').defaultValue, true);
  assert.ok(Notification.schema.path('type').enumValues.includes('reminder'));
});

test('Question of the Day is the same all day, rotates daily, and prefills a tagged answer', () => {
  const a = questionOfTheDay(new Date('2026-10-14T01:00:00Z'));
  const b = questionOfTheDay(new Date('2026-10-14T23:00:00Z'));
  const c = questionOfTheDay(new Date('2026-10-15T01:00:00Z'));
  assert.equal(a.text, b.text);
  assert.notEqual(a.text, c.text);
  assert.ok(QUESTIONS.length >= 40 && new Set(QUESTIONS).size === QUESTIONS.length);
  assert.equal(answerPrefill(a), `${a.text}\n\n#qotd`);
  assert.equal(startOfDay(new Date('2026-10-14T18:30:00Z')).toISOString(), '2026-10-14T00:00:00.000Z');
});

test('unsubscribe and question pages render', async () => {
  const views = path.join(__dirname, '..', 'src', 'views');
  const helpers = { icon: () => '', csrfToken: 't', cspNonce: 'n', appUrl: 'https://app.example.com', currentUser: null, flash: null, partners: [], renderRichBody: (v) => v, renderMentions: (v) => v, renderInlineText: (v) => v, plainText: (v) => v, preview: (v) => v, gifsEnabled: false, isStaging: false };
  for (const state of ['confirm', 'done', 'invalid', 'error']) {
    const html = await ejs.renderFile(path.join(views, 'pages', 'unsubscribe.ejs'), { ...helpers, title: 'x', state, kind: 'reminders', id: oid(1), token: 'f'.repeat(32) }, { views: [views] });
    assert.match(html, state === 'confirm' ? /Yes, stop the reminders/ : /Crowdwide/);
  }
  const q = questionOfTheDay(NOON);
  const empty = await ejs.renderFile(path.join(views, 'pages', 'question.ejs'), { ...helpers, title: 'Question of the Day', description: 'd', pagePath: '/question', canonicalUrl: 'https://app.example.com/question', question: q, answers: [], total: 0 }, { views: [views] });
  assert.match(empty, /Join to answer/);
  assert.match(empty, /Be the first to answer/);
});

test('the CSRF layer lets signed unsubscribe POSTs through without a session token', () => {
  const { csrfProtection } = require('../src/middleware/security');
  let passed = false;
  csrfProtection({ is: () => false, path: `/unsubscribe/reminders/${oid(1)}/${'f'.repeat(32)}`, method: 'POST', headers: {}, body: {} }, {}, () => { passed = true; });
  assert.equal(passed, true);
});
