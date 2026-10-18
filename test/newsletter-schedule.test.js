// Weekly newsletter timing: Sunday 10:30 on each member's own clock, with
// catch-up after downtime, a six-day (not seven) gap, and a default zone.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
delete process.env.NEWSLETTER_TIMEZONE;

// ---- stubs installed BEFORE the worker is loaded -----------------------------
const feedService = require('../src/services/feedService');
feedService.getInterestProfile = async () => ({ interests: new Map([['makers', 1]]), authorAffinity: new Map() });
const mailer = require('../src/services/mailer');
const delivered = [];
let deliverResult = true;
mailer.sendWeeklyNewsletter = async (user) => { delivered.push(user.email); return deliverResult; };

const User = require('../src/models/User');
const Post = require('../src/models/Post');

const calls = { distinct: [], find: [], updates: [] };
let zonesInUse = [];
let candidates = [];
let posts = [];
User.distinct = async (field, filter) => { calls.distinct.push({ field, filter }); return zonesInUse; };
User.find = (query) => { calls.find.push(query); const chain = { select: () => chain, lean: async () => candidates }; return chain; };
User.updateOne = async (filter, update) => { calls.updates.push({ filter, update }); return { modifiedCount: 1 }; };
Post.find = () => { const chain = { sort: () => chain, limit: () => chain, populate: () => chain, lean: async () => posts }; return chain; };

const worker = require('../src/services/newsletterWorker');

const reset = () => {
  calls.distinct.length = 0; calls.find.length = 0; calls.updates.length = 0; delivered.length = 0;
  deliverResult = true; zonesInUse = []; candidates = []; posts = [];
};
const aPost = () => ({ _id: 'p1', author: { _id: 'someone-else', name: 'S' }, createdAt: new Date('2026-10-16T00:00:00Z'), hashtags: ['makers'], likes: [] });
const reader = (extra = {}) => ({ _id: 'u1', name: 'Reader', email: 'reader@example.com', following: [], joinedCommunities: [], newsletterSentPosts: [], ...extra });

// Sunday 18 Oct 2026 is the day this was reported.
const at = (iso) => new Date(iso);

test('window: Sunday 10:30-22:30 on the member\'s own clock (Asia/Kolkata, including the old Asia/Calcutta name)', () => {
  for (const zone of ['Asia/Kolkata', 'Asia/Calcutta']) {
    assert.equal(worker.isNewsletterWindow(at('2026-10-18T04:59:00Z'), zone), false, '10:29 IST');
    assert.equal(worker.isNewsletterWindow(at('2026-10-18T05:00:00Z'), zone), true, '10:30 IST');
    assert.equal(worker.isNewsletterWindow(at('2026-10-18T10:30:00Z'), zone), true, '16:00 IST - what the old UTC cron produced');
    assert.equal(worker.isNewsletterWindow(at('2026-10-18T16:59:00Z'), zone), true, '22:29 IST');
    assert.equal(worker.isNewsletterWindow(at('2026-10-18T17:00:00Z'), zone), false, '22:30 IST');
  }
  assert.equal(worker.isNewsletterWindow(at('2026-10-19T05:00:00Z'), 'Asia/Kolkata'), false, 'Monday 10:30 IST');
  assert.equal(worker.isNewsletterWindow(at('2026-10-17T05:00:00Z'), 'Asia/Kolkata'), false, 'Saturday 10:30 IST');
});

test('window follows other zones and daylight saving', () => {
  // New York is on EDT (UTC-4) until 1 Nov 2026 and EST (UTC-5) after.
  assert.equal(worker.isNewsletterWindow(at('2026-10-18T14:29:00Z'), 'America/New_York'), false);
  assert.equal(worker.isNewsletterWindow(at('2026-10-18T14:30:00Z'), 'America/New_York'), true);
  assert.equal(worker.isNewsletterWindow(at('2026-11-08T15:29:00Z'), 'America/New_York'), false);
  assert.equal(worker.isNewsletterWindow(at('2026-11-08T15:30:00Z'), 'America/New_York'), true);
  assert.equal(worker.isNewsletterWindow(at('2026-10-18T10:30:00Z'), 'UTC'), true);
  // Far east: Sunday 10:30 in Auckland (NZDT, UTC+13) is Saturday 21:30 UTC.
  assert.equal(worker.isNewsletterWindow(at('2026-10-17T21:30:00Z'), 'Pacific/Auckland'), true);
});

test('timezone validation accepts IANA names and rejects junk', () => {
  assert.equal(worker.isValidTimezone('Asia/Calcutta'), true);
  assert.equal(worker.isValidTimezone('Europe/London'), true);
  for (const bad of ['', 'Mars/Base', 'not a zone', undefined, null, 5, 'A'.repeat(80)]) assert.equal(worker.isValidTimezone(bad), false);
});

test('cheap guard: only Saturday 18:00 UTC to Monday 12:00 UTC can be a Sunday window anywhere', () => {
  assert.equal(worker.mayBeSundayWindowSomewhere(at('2026-10-16T12:00:00Z')), false); // Friday
  assert.equal(worker.mayBeSundayWindowSomewhere(at('2026-10-17T17:59:00Z')), false);
  assert.equal(worker.mayBeSundayWindowSomewhere(at('2026-10-17T18:00:00Z')), true);
  assert.equal(worker.mayBeSundayWindowSomewhere(at('2026-10-18T12:00:00Z')), true);
  assert.equal(worker.mayBeSundayWindowSomewhere(at('2026-10-19T11:59:00Z')), true);
  assert.equal(worker.mayBeSundayWindowSomewhere(at('2026-10-19T12:00:00Z')), false);
});

test('midweek ticks return immediately and never query the database', async () => {
  reset();
  const result = await worker.sendWeeklyNewsletters({ now: at('2026-10-14T05:00:00Z') });
  assert.deepEqual(result, { eligible: 0, sent: 0, skippedNoPosts: 0 });
  assert.equal(calls.distinct.length + calls.find.length, 0);
});

test('Sunday 10:30 IST: only members whose own clock is in the window are selected, plus unset zones via the default (Asia/Kolkata)', async () => {
  reset();
  zonesInUse = ['Asia/Kolkata', 'America/New_York', 'Asia/Calcutta', 'Bogus/Zone'];
  candidates = [reader()];
  posts = [aPost()];
  const result = await worker.sendWeeklyNewsletters({ now: at('2026-10-18T05:00:00Z') });
  assert.deepEqual(result, { eligible: 1, sent: 1, skippedNoPosts: 0 });
  assert.deepEqual(delivered, ['reader@example.com']);

  const zoneClause = calls.find[0].$and[1].$or;
  assert.deepEqual(zoneClause[0], { timezone: { $in: ['Asia/Kolkata', 'Asia/Calcutta'] } }); // New York is still Saturday night
  assert.deepEqual(zoneClause[1], { timezone: { $in: [null, ''] } }); // default zone is in its window
  assert.deepEqual(zoneClause[2], { timezone: { $in: ['Bogus/Zone'] } }); // unusable saved zone falls back to the default
});

test('outside the default zone\'s window, members without a saved zone are NOT selected', async () => {
  reset();
  zonesInUse = ['America/New_York'];
  candidates = [];
  // 14:30 UTC: 10:30 in New York, but 20:00 IST... still inside the IST catch-up, so use 17:00 UTC (22:30 IST) with NY at 13:00.
  await worker.sendWeeklyNewsletters({ now: at('2026-10-18T17:00:00Z') });
  const zoneClause = calls.find[0].$and[1].$or;
  assert.deepEqual(zoneClause, [{ timezone: { $in: ['America/New_York'] } }]);
});

test('nothing due anywhere -> no member query at all', async () => {
  reset();
  zonesInUse = ['Asia/Kolkata'];
  const result = await worker.sendWeeklyNewsletters({ now: at('2026-10-18T17:00:00Z') }); // 22:30 IST, window closed; default zone also Kolkata
  assert.deepEqual(result, { eligible: 0, sent: 0, skippedNoPosts: 0 });
  assert.equal(calls.find.length, 0);
});

test('catch-up: a server that was asleep at 10:30 IST still sends on the next tick that Sunday', async () => {
  reset();
  zonesInUse = ['Asia/Kolkata'];
  candidates = [reader()];
  posts = [aPost()];
  const result = await worker.sendWeeklyNewsletters({ now: at('2026-10-18T09:12:00Z') }); // 14:42 IST
  assert.equal(result.sent, 1);
});

test('the gap is six days, so tick jitter cannot skip someone who was sent last Sunday', async () => {
  reset();
  zonesInUse = ['Asia/Kolkata'];
  candidates = [reader()];
  posts = [aPost()];
  const now = at('2026-10-18T05:00:00Z');
  await worker.sendWeeklyNewsletters({ now });
  const cutoff = calls.find[0].$and[0].$or[0].newsletterLastSentAt.$lte;
  assert.equal(now.getTime() - cutoff.getTime(), 6 * 24 * 60 * 60 * 1000);
  // Last Sunday's send (even a few seconds "later" in the day than this tick) is before that cutoff.
  assert.ok(new Date('2026-10-11T05:00:00.900Z') <= cutoff);
  // ...while a send earlier the same Sunday is not.
  assert.ok(!(new Date('2026-10-18T04:59:00Z') <= cutoff));
});

test('nothing new to recommend is counted as skipped and no mail is sent or claimed', async () => {
  reset();
  zonesInUse = ['Asia/Kolkata'];
  candidates = [reader({ newsletterSentPosts: ['p1'] })];
  posts = [aPost()];
  const result = await worker.sendWeeklyNewsletters({ now: at('2026-10-18T05:00:00Z') });
  assert.deepEqual(result, { eligible: 1, sent: 0, skippedNoPosts: 1 });
  assert.equal(delivered.length, 0);
  assert.equal(calls.updates.length, 0);

  reset();
  zonesInUse = ['Asia/Kolkata'];
  candidates = [reader()];
  posts = [];
  assert.equal((await worker.sendWeeklyNewsletters({ now: at('2026-10-18T05:00:00Z') })).skippedNoPosts, 1);
});

test('a failed delivery releases the claim so the next tick retries', async () => {
  reset();
  zonesInUse = ['Asia/Kolkata'];
  candidates = [reader()];
  posts = [aPost()];
  deliverResult = false;
  const result = await worker.sendWeeklyNewsletters({ now: at('2026-10-18T05:00:00Z') });
  assert.equal(result.sent, 0);
  assert.ok(calls.updates.some(({ update }) => update.$unset?.newsletterLastSentAt === 1));
  assert.ok(!calls.updates.some(({ update }) => update.$push));
});

test('force (npm run newsletter:send) ignores the day, the clock and member zones but keeps the six-day gap', async () => {
  reset();
  candidates = [reader()];
  posts = [aPost()];
  const result = await worker.sendWeeklyNewsletters({ now: at('2026-10-14T05:00:00Z'), force: true }); // a Wednesday
  assert.equal(result.sent, 1);
  assert.equal(calls.distinct.length, 0);
  assert.equal(calls.find[0].$and.length, 1);
  assert.ok(calls.find[0].$and[0].$or[0].newsletterLastSentAt.$lte);
});

test('NEWSLETTER_TIMEZONE changes the default zone used for members with no saved zone', async () => {
  reset();
  process.env.NEWSLETTER_TIMEZONE = 'America/New_York';
  try {
    zonesInUse = [];
    candidates = [reader()];
    posts = [aPost()];
    // 05:00 UTC Sunday is 01:00 in New York -> outside its window -> no query.
    assert.equal((await worker.sendWeeklyNewsletters({ now: at('2026-10-18T05:00:00Z') })).eligible, 0);
    assert.equal(calls.find.length, 0);
    // 14:30 UTC is 10:30 EDT -> inside.
    assert.equal((await worker.sendWeeklyNewsletters({ now: at('2026-10-18T14:30:00Z') })).sent, 1);
  } finally { delete process.env.NEWSLETTER_TIMEZONE; }
});

// ---- saving the member's zone ---------------------------------------------------
test('POST /settings/timezone stores a valid zone and rejects an invalid one', async () => {
  reset();
  const settings = require('../src/controllers/settingsController');
  const res = () => ({ code: null, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } });
  const ok = res();
  await settings.setTimezone({ body: { timezone: 'Asia/Calcutta' }, session: { user: { id: 'u1' } } }, ok);
  assert.equal(ok.code, 204);
  assert.deepEqual(calls.updates.at(-1), { filter: { _id: 'u1' }, update: { $set: { timezone: 'Asia/Calcutta' } } });

  const before = calls.updates.length;
  for (const bad of ['Mars/Base', '', undefined, '<script>']) {
    const r = res();
    await settings.setTimezone({ body: { timezone: bad }, session: { user: { id: 'u1' } } }, r);
    assert.equal(r.code, 400);
  }
  assert.equal(calls.updates.length, before);
  assert.equal(User.schema.path('timezone').defaultValue, '');
});

test('the browser script is loaded for signed-in members and sends the zone with the CSRF header', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const ejs = require('ejs');
  const foot = path.join(__dirname, '..', 'src', 'views', 'partials', 'foot.ejs');
  const signedIn = await ejs.renderFile(foot, { currentUser: { id: 'u', timezone: 'Asia/Calcutta' }, csrfToken: 't', icon: () => '', cspNonce: 'n' });
  assert.match(signedIn, /src="\/js\/timezone\.js"[^>]*data-saved="Asia\/Calcutta"/);
  const anonymous = await ejs.renderFile(foot, { currentUser: null, csrfToken: 't', icon: () => '', cspNonce: 'n' });
  assert.ok(!anonymous.includes('timezone.js'));
  const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'timezone.js'), 'utf8');
  assert.match(script, /X-CSRF-Token/);
  assert.match(script, /\/settings\/timezone/);
});
