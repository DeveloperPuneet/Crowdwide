const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');

const Advertiser = require('../src/models/Advertiser');
const Campaign = require('../src/models/Campaign');
const CampaignAbuseSignal = require('../src/models/CampaignAbuseSignal');
const CampaignEvent = require('../src/models/CampaignEvent');
const Community = require('../src/models/Community');
const Report = require('../src/models/Report');
const SiteSetting = require('../src/models/SiteSetting');
const User = require('../src/models/User');
const WavesLedgerEntry = require('../src/models/WavesLedgerEntry');
const { icon } = require('../src/utils/icons');
const { TASKS, TASK_LABELS } = require('../src/services/maintenance');
const advertisingController = require('../src/controllers/advertisingController');
const {
  ADVERTISING_TERMS_VERSION,
  AD_RETENTION_DAYS,
  cleanupFinishedCampaigns,
  deleteFinishedCampaigns,
  expireEndedCampaigns,
  submitAdvertisement,
  updateCampaignStatus
} = require('../src/services/advertising');

const DAY = 24 * 60 * 60 * 1000;
const chain = (rows) => ({ select() { return this; }, limit() { return this; }, sort() { return this; }, populate() { return this; }, lean: async () => rows });
const approvedAdvertiser = () => ({
  _id: 'adv-1', user: 'user-1', status: 'approved', viaCampaign: false,
  termsVersion: ADVERTISING_TERMS_VERSION, termsAcceptedAt: new Date(),
  toObject() { return { ...this }; }, async save() { return this; }
});
const adInput = (extra = {}) => ({
  title: 'Launch', campaignType: 'service', description: 'Great service', destinationUrl: 'https://example.com/',
  advertisingRightsConfirmed: true, totalBudget: 40, dailyBudget: 0, sitewideFallback: true, targetCommunities: [], ...extra
});

// Mocks wallet + ledger + campaign persistence so a whole submission can run without MongoDB.
function mockSubmissionPlumbing(t, { balance = 100, debit = 1, advertiserForLookup } = {}) {
  const created = [];
  const ledger = [];
  t.mock.method(User, 'findById', () => chain({ wavesBalance: balance }));
  t.mock.method(User, 'updateOne', async () => ({ modifiedCount: debit }));
  t.mock.method(WavesLedgerEntry, 'create', async (entry) => {
    const doc = { ...entry, async save() { return this; } };
    ledger.push(doc);
    return doc;
  });
  t.mock.method(Campaign, 'create', async (data) => {
    const doc = { _id: `campaign-${created.length + 1}`, moderationHistory: [], async save() { return this; }, ...data };
    created.push(doc);
    return doc;
  });
  t.mock.method(Campaign, 'findById', async (id) => created.find((c) => c._id === id) || null);
  const deleted = [];
  t.mock.method(Campaign, 'deleteOne', async (filter) => { deleted.push(filter); return { deletedCount: 1 }; });
  if (advertiserForLookup) t.mock.method(Advertiser, 'findById', async () => advertiserForLookup);
  return { created, ledger, deleted };
}

test('one submission funds the budget and sends an approved advertiser\'s ad straight to review', async (t) => {
  const advertiser = approvedAdvertiser();
  t.mock.method(Advertiser, 'findOne', async () => advertiser);
  const { created, ledger } = mockSubmissionPlumbing(t, { advertiserForLookup: advertiser });

  const result = await submitAdvertisement({ userId: 'user-1', acceptedTerms: true, campaign: adInput() });
  assert.equal(result.firstTime, false);
  assert.equal(created.length, 1);
  assert.equal(result.campaign.status, 'submitted');
  assert.equal(result.campaign.fundingStatus, 'funded');
  assert.equal(result.campaign.remainingBudget, 40);
  assert.equal(result.campaign.moderatorReview.status, 'pending');
  assert.equal(ledger[0].amount, -40);
  assert.equal(ledger[0].status, 'posted');
});

test('a first-time advertiser enters business and ad details once; no separate application is created', async (t) => {
  let upsert;
  const pending = { _id: 'adv-new', user: 'user-1', status: 'pending', viaCampaign: true, termsVersion: ADVERTISING_TERMS_VERSION, termsAcceptedAt: new Date() };
  t.mock.method(Advertiser, 'findOne', async () => null);
  t.mock.method(Advertiser, 'findOneAndUpdate', async (query, update) => { upsert = update; return pending; });
  const { created } = mockSubmissionPlumbing(t, { advertiserForLookup: pending });

  const result = await submitAdvertisement({
    userId: 'user-1', acceptedTerms: true,
    business: { businessName: 'Bright Studio', businessDescription: 'Prints and art', website: 'https://bright.example.test' },
    campaign: adInput()
  });
  assert.equal(result.firstTime, true);
  assert.equal(upsert.viaCampaign, true);
  assert.equal(upsert.status, 'pending');
  assert.equal(upsert.businessName, 'Bright Studio');
  assert.equal(created[0].status, 'submitted');
  assert.equal(result.campaign.advertiser, 'adv-new');
});

test('first-time submissions need business details, and anything invalid writes nothing', async (t) => {
  t.mock.method(Advertiser, 'findOne', async () => null);
  const upsert = t.mock.method(Advertiser, 'findOneAndUpdate', async () => ({}));
  mockSubmissionPlumbing(t);
  await assert.rejects(() => submitAdvertisement({ userId: 'user-1', acceptedTerms: true, business: { businessName: 'X' }, campaign: adInput() }), /business name and a short business description/i);
  await assert.rejects(() => submitAdvertisement({ userId: 'user-1', acceptedTerms: false, business: { businessName: 'X', businessDescription: 'Y' }, campaign: adInput() }), /Accept the Advertising Terms/);
  await assert.rejects(() => submitAdvertisement({ userId: 'user-1', acceptedTerms: true, business: { businessName: 'X', businessDescription: 'Y', website: 'ftp://nope' }, campaign: adInput() }), /valid website URL/);
  assert.equal(upsert.mock.callCount(), 0);
});

test('a wallet that cannot cover the budget is rejected before any advertiser or campaign is written', async (t) => {
  t.mock.method(Advertiser, 'findOne', async () => null);
  const upsert = t.mock.method(Advertiser, 'findOneAndUpdate', async () => ({}));
  const { created } = mockSubmissionPlumbing(t, { balance: 10 });
  await assert.rejects(() => submitAdvertisement({
    userId: 'user-1', acceptedTerms: true, business: { businessName: 'X', businessDescription: 'Y' }, campaign: adInput()
  }), /at least 40 Waves/);
  assert.equal(upsert.mock.callCount(), 0);
  assert.equal(created.length, 0);
});

test('if funding fails mid-way the draft campaign and the just-created advertiser are removed', async (t) => {
  const pending = { _id: 'adv-new', user: 'user-1', status: 'pending', viaCampaign: true, termsVersion: ADVERTISING_TERMS_VERSION, termsAcceptedAt: new Date() };
  t.mock.method(Advertiser, 'findOne', async () => null);
  t.mock.method(Advertiser, 'findOneAndUpdate', async () => pending);
  const advertiserDeletes = [];
  t.mock.method(Advertiser, 'deleteOne', async (filter) => { advertiserDeletes.push(filter); return { deletedCount: 1 }; });
  const { deleted } = mockSubmissionPlumbing(t, { debit: 0, advertiserForLookup: pending });

  await assert.rejects(() => submitAdvertisement({
    userId: 'user-1', acceptedTerms: true, business: { businessName: 'X', businessDescription: 'Y' }, campaign: adInput()
  }), /insufficient Waves balance/i);
  assert.deepEqual(deleted, [{ _id: 'campaign-1' }]);
  assert.deepEqual(advertiserDeletes, [{ _id: 'adv-new' }]);
});

test('an advertiser whose previous ad is still in review cannot pile up submissions', async (t) => {
  t.mock.method(Advertiser, 'findOne', async () => ({ status: 'pending', viaCampaign: true }));
  await assert.rejects(() => submitAdvertisement({ userId: 'user-1', acceptedTerms: true, campaign: adInput() }), /still being reviewed/);
  t.mock.method(Advertiser, 'findOne', async () => ({ status: 'suspended' }));
  await assert.rejects(() => submitAdvertisement({ userId: 'user-1', acceptedTerms: true, campaign: adInput() }), /suspended/);
});

function submittedCampaign(extra = {}) {
  return {
    _id: 'campaign-review', advertiser: 'adv-1', title: 'Launch', status: 'submitted', isWavesFunded: true,
    fundingStatus: 'funded', fundingUser: 'user-1', totalBudget: 40, remainingBudget: 40,
    moderatorReview: { status: 'cleared', reason: 'Fine', reviewedBy: 'mod-1' }, moderationHistory: [],
    async save() { return this; }, ...extra
  };
}

test('admin approval makes a submitted ad live and approves a first-time advertiser with it', async (t) => {
  const campaign = submittedCampaign();
  const advertiser = { _id: 'adv-1', status: 'pending', viaCampaign: true, isVerified: false, moderationHistory: [], async save() { return this; } };
  t.mock.method(Campaign, 'findById', async () => campaign);
  t.mock.method(Advertiser, 'findById', async () => advertiser);

  const result = await updateCampaignStatus({ campaignId: campaign._id, status: 'approved', actorId: 'admin-1', activateOnApproval: true });
  assert.equal(result.status, 'active');
  assert.ok(result.approvedAt instanceof Date);
  assert.equal(result.finishedAt, undefined);
  assert.deepEqual(result.moderationHistory.map((e) => e.status), ['approved', 'active']);
  assert.equal(advertiser.status, 'approved');
  assert.equal(advertiser.isVerified, true);
  assert.equal(advertiser.moderatorReview.status, 'cleared');
});

test('approval without the go-live option keeps the legacy approved state', async (t) => {
  const campaign = submittedCampaign();
  t.mock.method(Campaign, 'findById', async () => campaign);
  t.mock.method(Advertiser, 'findById', async () => ({ _id: 'adv-1', status: 'approved' }));
  const result = await updateCampaignStatus({ campaignId: campaign._id, status: 'approved', actorId: 'admin-1' });
  assert.equal(result.status, 'approved');
});

test('an ad whose end date passed while it waited is closed and refunded instead of going live', async (t) => {
  const campaign = submittedCampaign({ endDate: new Date(Date.now() - DAY) });
  t.mock.method(Campaign, 'findById', async () => campaign);
  t.mock.method(Advertiser, 'findById', async () => ({ _id: 'adv-1', status: 'approved' }));
  t.mock.method(WavesLedgerEntry, 'create', async (entry) => ({ ...entry, async save() { return this; } }));
  t.mock.method(User, 'updateOne', async () => ({ modifiedCount: 1 }));
  t.mock.method(User, 'findById', () => chain({ wavesBalance: 40 }));

  const result = await updateCampaignStatus({ campaignId: campaign._id, status: 'approved', actorId: 'admin-1', activateOnApproval: true });
  assert.equal(result.status, 'completed');
  assert.equal(result.fundingStatus, 'refunded');
  assert.equal(result.refundedBudget, 40);
  assert.ok(result.finishedAt instanceof Date);
});

test('rejecting a first-time advertiser\'s ad rejects the advertiser too so they can resubmit', async (t) => {
  const campaign = submittedCampaign({ moderatorReview: { status: 'flagged', reason: 'Policy' } });
  const advertiser = { _id: 'adv-1', status: 'pending', viaCampaign: true, moderationHistory: [], async save() { return this; } };
  t.mock.method(Campaign, 'findById', async () => campaign);
  t.mock.method(Advertiser, 'findById', async () => advertiser);
  t.mock.method(WavesLedgerEntry, 'create', async (entry) => ({ ...entry, async save() { return this; } }));
  t.mock.method(User, 'updateOne', async () => ({ modifiedCount: 1 }));
  t.mock.method(User, 'findById', () => chain({ wavesBalance: 40 }));

  const result = await updateCampaignStatus({ campaignId: campaign._id, status: 'rejected', rejectionReason: 'Not allowed', actorId: 'admin-1', activateOnApproval: true });
  assert.equal(result.status, 'rejected');
  assert.ok(result.finishedAt instanceof Date);
  assert.equal(advertiser.status, 'rejected');
  assert.equal(advertiser.rejectionReason, 'Not allowed');
});

test('stopping a campaign stamps finishedAt so the 10-day retention clock starts', async (t) => {
  const campaign = submittedCampaign({ status: 'active', remainingBudget: 0, fundingStatus: 'funded' });
  t.mock.method(Campaign, 'findById', async () => campaign);
  const result = await updateCampaignStatus({ campaignId: campaign._id, status: 'cancelled', actorId: 'user-1' });
  assert.equal(result.status, 'cancelled');
  assert.ok(result.finishedAt instanceof Date);
});

test('finished campaigns older than 10 days are deleted with their events, signals, reports and banner', async (t) => {
  assert.equal(AD_RETENTION_DAYS, 10);
  const now = new Date('2026-10-15T00:00:00Z');
  let findFilter;
  t.mock.method(Campaign, 'find', (filter) => { findFilter = filter; return chain([
    { _id: 'done-1', bannerUrl: '/media/0/0123456789abcdef01234567' },
    { _id: 'done-2', bannerUrl: '' },
    { _id: 'owes-share', bannerUrl: '' }
  ]); });
  t.mock.method(CampaignEvent, 'distinct', async () => ['owes-share']);
  const calls = {};
  t.mock.method(CampaignEvent, 'deleteMany', async (f) => { calls.events = f; return { deletedCount: 7 }; });
  t.mock.method(CampaignAbuseSignal, 'deleteMany', async (f) => { calls.signals = f; return { deletedCount: 1 }; });
  t.mock.method(Report, 'deleteMany', async (f) => { calls.reports = f; return { deletedCount: 2 }; });
  t.mock.method(Campaign, 'deleteMany', async (f) => { calls.campaigns = f; return { deletedCount: 2 }; });

  const result = await deleteFinishedCampaigns({ now });
  const cutoff = new Date(now.getTime() - 10 * DAY);
  assert.equal(findFilter.remainingBudget.$lte, 0);
  assert.deepEqual(findFilter.$or[0].status.$in, ['completed', 'cancelled', 'rejected']);
  assert.deepEqual(findFilter.$or[0].$or[0], { finishedAt: { $lte: cutoff } });
  assert.deepEqual(findFilter.$or[1], { status: 'paused', updatedAt: { $lte: cutoff } });
  assert.deepEqual(calls.campaigns, { _id: { $in: ['done-1', 'done-2'] } });
  assert.deepEqual(calls.events, { campaign: { $in: ['done-1', 'done-2'] } });
  assert.deepEqual(calls.signals, { campaign: { $in: ['done-1', 'done-2'] } });
  assert.deepEqual(calls.reports, { targetType: 'advertisement', target: { $in: ['done-1', 'done-2'] } });
  assert.deepEqual(result, { campaigns: 2, events: 7, abuseSignals: 1, reports: 2, bannerFiles: 1, skipped: 1 });
});

test('cleanup deletes nothing when no campaign has been finished for 10 days', async (t) => {
  t.mock.method(Campaign, 'find', () => chain([]));
  const del = t.mock.method(Campaign, 'deleteMany', async () => ({ deletedCount: 0 }));
  const result = await deleteFinishedCampaigns({ now: new Date() });
  assert.equal(result.campaigns, 0);
  assert.equal(del.mock.callCount(), 0);
});

test('campaigns past their end date are closed (and refunded) so they can age out', async (t) => {
  const now = new Date('2026-10-15T00:00:00Z');
  let filter;
  const campaign = submittedCampaign({ _id: 'ended-1', status: 'active', remainingBudget: 12, endDate: new Date('2026-10-01') });
  t.mock.method(Campaign, 'find', (f) => { filter = f; return chain([{ _id: 'ended-1' }]); });
  t.mock.method(Campaign, 'findById', async () => campaign);
  t.mock.method(WavesLedgerEntry, 'create', async (entry) => ({ ...entry, async save() { return this; } }));
  t.mock.method(User, 'updateOne', async () => ({ modifiedCount: 1 }));
  t.mock.method(User, 'findById', () => chain({ wavesBalance: 12 }));

  const result = await expireEndedCampaigns(now);
  assert.deepEqual(filter.status.$in, ['active', 'approved', 'paused']);
  assert.deepEqual(filter.endDate, { $ne: null, $lt: now });
  assert.deepEqual(result, { expired: 1, failed: 0 });
  assert.equal(campaign.status, 'completed');
  assert.equal(campaign.refundedBudget, 12);
});

test('the daily maintenance run includes the 10-day ad cleanup', async (t) => {
  assert.ok(Object.hasOwn(TASKS, 'finished-ad-campaigns'));
  assert.match(TASK_LABELS['finished-ad-campaigns'], /10 days/);
  const filters = [];
  t.mock.method(Campaign, 'find', (f) => { filters.push(f); return chain([]); });
  const now = new Date('2026-10-15T00:00:00Z');
  const result = await TASKS['finished-ad-campaigns'](new Date(0), { now });
  assert.equal(result.campaigns, 0);
  assert.equal(result.closedEnded, 0);
  assert.deepEqual(filters[1].$or[0].$or[0], { finishedAt: { $lte: new Date(now.getTime() - 10 * DAY) } });
  const direct = await cleanupFinishedCampaigns({ now });
  assert.equal(direct.skipped, 0);
});

// ----- controller -----
function fakeRes() { return { redirect(p) { this.path = p; } }; }
function fakeReq(body = {}) { return { session: { user: { id: 'user-1' } }, body, files: {} }; }
const validBody = (extra = {}) => ({
  title: 'Launch', campaignType: 'service', destinationUrl: 'https://example.com', totalBudget: '40', sitewideFallback: 'on',
  confirmAdvertisingRights: 'on', acceptAdvertisingTerms: 'on', businessName: 'Bright Studio', businessDescription: 'Prints', ...extra
});
function mockControllerLookups(t, advertiser = null) {
  t.mock.method(Advertiser, 'findOne', async () => advertiser);
  t.mock.method(Community, 'find', () => chain([]));
  t.mock.method(Community, 'exists', async () => null);
  t.mock.method(SiteSetting, 'getSingleton', async () => ({ advertisingMinimumCampaignBudget: 25, advertisingCostPerImpression: 0.1, advertisingCostPerClick: 1 }));
}

test('the single ad form refuses to submit without terms, rights confirmation, a valid link or a future end date', async (t) => {
  mockControllerLookups(t);
  for (const [extra, message] of [
    [{ acceptAdvertisingTerms: undefined }, /Advertising Terms/],
    [{ confirmAdvertisingRights: undefined }, /own or are authorized/],
    [{ destinationUrl: 'javascript:alert(1)' }, /valid http or https/],
    [{ totalBudget: '5' }, /at least 25 Waves/],
    [{ endDate: '2020-01-01' }, /end date cannot be in the past/],
    [{ sitewideFallback: undefined }, /Choose smart placement, a monetized community/]
  ]) {
    const req = fakeReq(validBody(extra));
    const res = fakeRes();
    await advertisingController.submitAd(req, res);
    assert.equal(res.path, '/advertising');
    assert.equal(req.session.flash.type, 'error');
    assert.match(req.session.flash.message, message);
  }
});

test('the single ad form submits everything in one request and explains what happens next', async (t) => {
  mockControllerLookups(t);
  const pending = { _id: 'adv-new', user: 'user-1', status: 'pending', viaCampaign: true, termsVersion: ADVERTISING_TERMS_VERSION, termsAcceptedAt: new Date() };
  t.mock.method(Advertiser, 'findOneAndUpdate', async () => pending);
  const { created } = mockSubmissionPlumbing(t, { advertiserForLookup: pending });
  const req = fakeReq(validBody());
  const res = fakeRes();
  await advertisingController.submitAd(req, res);
  assert.equal(req.session.flash.type, 'success');
  assert.match(req.session.flash.message, /40 Waves reserved/);
  assert.match(req.session.flash.message, /goes live automatically/);
  assert.equal(created[0].status, 'submitted');
  assert.equal(created[0].destinationUrl, 'https://example.com/');
});

// ----- views -----
const views = path.join(__dirname, '..', 'src', 'views');
const baseView = { icon, csrfToken: 'tok', flash: null, currentUser: { id: 'u1', name: 'Asha', role: 'user', wavesBalance: 120 }, appUrl: 'http://x', gifsEnabled: true };
const render = (file, data) => ejs.renderFile(path.join(views, file), { ...baseView, ...data });
const dashboardBase = {
  title: 'Advertising dashboard', pagePath: '/advertising', noIndex: true, communities: [], campaigns: [],
  campaignAnalytics: { byCommunity: [], daily: [] }, sitewideFallbackAvailable: true, adRetentionDays: 10,
  totals: { impressions: 0, clicks: 0, ctr: 0, wavesSpent: 0, remainingBudget: 0 }
};

test('a new advertiser sees one form with business, ad and budget fields and a single submit button', async () => {
  const html = await render('pages/advertising-dashboard.ejs', { ...dashboardBase, advertiser: null });
  assert.equal((html.match(/action="\/advertising\/submit"/g) || []).length, 1);
  for (const field of ['businessName', 'businessDescription', 'title', 'destinationUrl', 'totalBudget', 'confirmAdvertisingRights', 'acceptAdvertisingTerms']) {
    assert.match(html, new RegExp(`name="${field}"`), field);
  }
  assert.match(html, /Submit ad for approval/);
  assert.match(html, /deleted 10 days after they finish/);
  assert.doesNotMatch(html, /\/advertising\/apply|Save draft|Apply as an advertiser/);
});

test('an approved advertiser is not asked for business details again', async () => {
  const html = await render('pages/advertising-dashboard.ejs', { ...dashboardBase, advertiser: { _id: 'a1', status: 'approved', businessName: 'Example Co' } });
  assert.match(html, /action="\/advertising\/submit"/);
  assert.doesNotMatch(html, /name="businessName"/);
  assert.match(html, /name="totalBudget"/);
});

test('an advertiser waiting on their first ad review sees status instead of another form', async () => {
  const html = await render('pages/advertising-dashboard.ejs', {
    ...dashboardBase,
    advertiser: { _id: 'a1', status: 'pending', viaCampaign: true, businessName: 'Example Co', moderationHistory: [] },
    campaigns: [{ _id: 'c1', title: 'Launch', status: 'submitted', fundingStatus: 'funded', remainingBudget: 40, moderatorReview: { status: 'pending' }, moderationHistory: [] }]
  });
  assert.doesNotMatch(html, /action="\/advertising\/submit"/);
  assert.match(html, /reviewed by a moderator and then an admin/);
  assert.match(html, /goes live automatically once approved/);
});

test('finished campaigns show the date their data will be deleted', async () => {
  const finishedAt = new Date('2026-10-01T00:00:00Z');
  const html = await render('pages/advertising-dashboard.ejs', {
    ...dashboardBase,
    advertiser: { _id: 'a1', status: 'approved', businessName: 'Example Co' },
    campaigns: [{ _id: 'c1', title: 'Old', status: 'completed', fundingStatus: 'funded', remainingBudget: 0, finishedAt, moderationHistory: [] }]
  });
  assert.match(html, new RegExp(`will be deleted on ${new Date(finishedAt.getTime() + 10 * DAY).toLocaleDateString().replace(/[/.]/g, '\\$&')}`));
  assert.match(html, /Stop and refund|campaign-status-completed/);
});

test('moderators and admins see a first-time advertiser\'s business details on the ad itself', async () => {
  const partial = await render('partials/advertiser-details.ejs', {
    advertiser: { status: 'pending', viaCampaign: true, businessName: 'Bright Studio', businessDescription: 'Prints and art', website: 'https://bright.example.test', notes: 'Local maker' }
  });
  assert.match(partial, /New advertiser: Bright Studio/);
  assert.match(partial, /Prints and art/);
  assert.match(partial, /bright\.example\.test/);
  const approved = await render('partials/advertiser-details.ejs', { advertiser: { status: 'approved', viaCampaign: true, businessName: 'Bright Studio' } });
  assert.equal(approved.trim(), '');
  for (const view of ['moderator.ejs', 'admin.ejs']) {
    assert.match(fs.readFileSync(path.join(views, 'pages', view), 'utf8'), /partials\/advertiser-details/);
  }
});
