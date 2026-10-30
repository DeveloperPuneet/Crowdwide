// Partnership program: validation, review workflow, public strips, legal pages, admin panels and route protection.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { icon } = require('../src/utils/icons');
const Partner = require('../src/models/Partner');
const PartnershipApplication = require('../src/models/PartnershipApplication');
const partnerships = require('../src/services/partnerships');
const { requireAdmin } = require('../src/middleware/roles');
const webController = require('../src/controllers/webController');
const partnershipController = require('../src/controllers/partnershipController');
const mailer = require('../src/services/mailer');
const { TASKS, TASK_LABELS } = require('../src/services/maintenance');

const { PartnershipError } = partnerships;
const views = path.join(__dirname, '..', 'src', 'views');
const render = (file, data = {}) => ejs.renderFile(path.join(views, file), {
  icon, csrfToken: 'tok', flash: null, appUrl: 'http://x', currentUser: null, partners: [], ...data
});
const goodForm = (extra = {}) => ({
  organizationName: 'Bright Studio', organizationType: 'company', websiteUrl: 'https://www.brightstudio.com',
  contactName: 'Asha Rao', contactEmail: 'Asha@BrightStudio.com', country: 'India',
  description: 'A small illustration studio making prints and children\'s books.',
  collaboration: 'We would like to show each other\'s logos and co-host a drawing event.',
  authorized: 'on', accurate: 'on', ownsAssets: 'on', acceptsTerms: 'on', displayConsent: 'on', lawfulContent: 'on', ...extra
});

// ---------- validation ----------
test('parseWebsite accepts public sites and rejects unsafe or local addresses', () => {
  assert.equal(partnerships.parseWebsite('brightstudio.com').host, 'brightstudio.com');
  assert.equal(partnerships.parseWebsite('https://Shop.Example.org/path#frag').url, 'https://shop.example.org/path');
  for (const bad of ['javascript:alert(1)', 'ftp://x.com', 'http://localhost', 'http://127.0.0.1', 'https://[::1]/', 'https://user:pw@site.com', 'https://intranet', 'not a url', 'https://printer.local']) {
    assert.throws(() => partnerships.parseWebsite(bad), PartnershipError, bad);
  }
  assert.equal(partnerships.parseWebsite('', { required: false }), null);
});

test('validateApplication normalizes a good request and flags email/website match', () => {
  const data = partnerships.validateApplication(goodForm());
  assert.equal(data.contactEmail, 'asha@brightstudio.com');
  assert.equal(data.websiteHost, 'www.brightstudio.com');
  assert.equal(data.emailMatchesWebsite, true);
  assert.equal(partnerships.validateApplication(goodForm({ contactEmail: 'asha@gmail.com' })).emailMatchesWebsite, false);
  assert.ok(Object.values(data.attestations).every(Boolean));
});

test('validateApplication rejects missing fields and every unticked confirmation', () => {
  assert.throws(() => partnerships.validateApplication(goodForm({ organizationName: ' ' })), /organization/i);
  assert.throws(() => partnerships.validateApplication(goodForm({ organizationType: 'bogus' })), /type of organization/i);
  assert.throws(() => partnerships.validateApplication(goodForm({ contactEmail: 'nope' })), /valid contact email/i);
  assert.throws(() => partnerships.validateApplication(goodForm({ description: 'too short' })), /at least 30/);
  for (const key of partnerships.ATTESTATIONS) {
    assert.throws(() => partnerships.validateApplication(goodForm({ [key]: undefined })), /confirmation box/i, key);
  }
});

// ---------- submission ----------
test('submitApplication saves a pending request with the accepted terms version', async (t) => {
  t.mock.method(PartnershipApplication, 'findOne', () => ({ select: () => ({ lean: async () => null }) }));
  t.mock.method(Partner, 'findOne', () => ({ select: () => ({ lean: async () => null }) }));
  t.mock.method(PartnershipApplication, 'countDocuments', async () => 0);
  const create = t.mock.method(PartnershipApplication, 'create', async (doc) => ({ ...doc, _id: 'a1' }));
  const app = await partnerships.submitApplication(goodForm(), { ipAddress: '203.0.113.5' });
  assert.match(app.reference, /^CWP-[0-9A-F]{8}$/);
  assert.equal(app.termsVersion, partnerships.PARTNERSHIP_TERMS_VERSION);
  assert.equal(app.ipAddress, '203.0.113.5');
  assert.equal(create.mock.callCount(), 1);
});

test('submitApplication blocks duplicates, existing partners and floods', async (t) => {
  const stub = ({ open = null, partner = null, recent = 0 }) => {
    t.mock.restoreAll();
    t.mock.method(PartnershipApplication, 'findOne', () => ({ select: () => ({ lean: async () => open }) }));
    t.mock.method(Partner, 'findOne', () => ({ select: () => ({ lean: async () => partner }) }));
    t.mock.method(PartnershipApplication, 'countDocuments', async () => recent);
    return t.mock.method(PartnershipApplication, 'create', async (doc) => doc);
  };
  let create = stub({ open: { status: 'pending' } });
  await assert.rejects(() => partnerships.submitApplication(goodForm()), /already waiting for review/);
  create = stub({ partner: { _id: 'p' } });
  await assert.rejects(() => partnerships.submitApplication(goodForm()), /already a Crowdwide partner/);
  create = stub({ recent: 3 });
  await assert.rejects(() => partnerships.submitApplication(goodForm()), /several requests today/);
  assert.equal(create.mock.callCount(), 0);
});

// ---------- review ----------
test('approving creates a hidden partner; rejecting requires a reason', async (t) => {
  const saved = [];
  const application = { _id: 'a1', organizationName: 'Bright Studio', websiteUrl: 'https://www.brightstudio.com/', websiteHost: 'www.brightstudio.com', status: 'approved', async save() { saved.push(this.partner); } };
  const update = t.mock.method(PartnershipApplication, 'findOneAndUpdate', async (filter) => { assert.equal(filter.status, 'pending'); return application; });
  const create = t.mock.method(Partner, 'create', async (doc) => ({ ...doc, _id: 'p1' }));
  await partnerships.reviewApplication({ applicationId: 'a1', decision: 'approved', actorId: 'admin1' });
  assert.equal(create.mock.calls[0].arguments[0].isVisible, false, 'approved partners stay hidden until a logo is added');
  assert.equal(create.mock.calls[0].arguments[0].name, 'Bright Studio');
  assert.deepEqual(saved, ['p1']);
  await assert.rejects(() => partnerships.reviewApplication({ applicationId: 'a1', decision: 'rejected', actorId: 'admin1' }), /reason/i);
  await assert.rejects(() => partnerships.reviewApplication({ applicationId: 'a1', decision: 'maybe', actorId: 'admin1' }), /approve or reject/i);
  update.mock.mockImplementation(async () => null);
  await assert.rejects(() => partnerships.reviewApplication({ applicationId: 'a1', decision: 'approved', actorId: 'x' }), /already been decided/);
});

test('partner input is validated and removal ends the linked application', async (t) => {
  assert.throws(() => partnerships.validatePartnerInput({ name: 'A', websiteUrl: 'https://a.com' }), /partner name/i);
  const ok = partnerships.validatePartnerInput({ name: 'Acme', websiteUrl: 'acme.org', displayOrder: '12', isVisible: 'on' });
  assert.deepEqual([ok.displayOrder, ok.isVisible, ok.showOnLanding, ok.websiteHost], [12, true, false, 'acme.org']);
  const upd = t.mock.method(PartnershipApplication, 'updateOne', async () => ({}));
  t.mock.method(Partner, 'findByIdAndDelete', async () => ({ _id: 'p1', name: 'Acme', logoUrl: '', application: 'a1' }));
  await partnerships.removePartner('64b7f0f0f0f0f0f0f0f0f0a1');
  assert.equal(upd.mock.calls[0].arguments[1].$set.status, 'ended');
  await assert.rejects(() => partnerships.removePartner('bad-id'), /not found/i);
});

test('getVisiblePartners is safe without a database connection', async () => {
  assert.deepEqual(await partnerships.getVisiblePartners(), []);
});

test('rejected and ended applications are covered by the retention clean-up task', async (t) => {
  assert.ok(TASKS['partnership-applications']);
  assert.match(TASK_LABELS['partnership-applications'], /180 days/);
  const del = t.mock.method(PartnershipApplication, 'deleteMany', async (filter) => { assert.deepEqual(filter.status.$in, ['rejected', 'ended']); return { deletedCount: 2 }; });
  assert.deepEqual(await partnerships.cleanupOldApplications(), { applications: 2 });
  assert.equal(del.mock.callCount(), 1);
});

// ---------- public controller ----------
function fakeRes() { return { redirected: null, rendered: null, redirect(p) { this.redirected = p; }, render(v, l) { this.rendered = { v, l }; } }; }
test('apply page issues a challenge and remembers the render time; bots are bounced', async (t) => {
  const req = { session: {}, body: {}, ip: '1.1.1.1' };
  const res = fakeRes();
  partnershipController.applyPage(req, res);
  assert.equal(res.rendered.v, 'pages/partnership-apply');
  assert.ok(req.session.partnershipFormShownAt);
  assert.ok(req.session.captcha);
  const create = t.mock.method(PartnershipApplication, 'create', async (d) => d);
  const botReq = { session: { partnershipFormShownAt: Date.now() - 60000, captcha: { answer: 5, createdAt: Date.now() } }, body: { ...goodForm(), companyFax: 'spam', captchaAnswer: '5' }, ip: '1.1.1.1' };
  const botRes = fakeRes();
  await partnershipController.submitApplication(botReq, botRes);
  assert.equal(botRes.redirected, '/partnerships/apply');
  assert.match(botReq.session.flash.message, /verification/i);
  assert.equal(botReq.session.partnershipForm.organizationName, 'Bright Studio', 'form is kept so a person does not retype it');
  const wrongReq = { session: { partnershipFormShownAt: Date.now() - 60000, captcha: { answer: 5, createdAt: Date.now() } }, body: { ...goodForm(), captchaAnswer: '9' }, ip: '1.1.1.1' };
  await partnershipController.submitApplication(wrongReq, fakeRes());
  assert.match(wrongReq.session.flash.message, /verification/i);
  assert.equal(create.mock.callCount(), 0);
});

test('a verified request is saved, acknowledged by email and answered with a receipt page', async (t) => {
  t.mock.method(PartnershipApplication, 'findOne', () => ({ select: () => ({ lean: async () => null }) }));
  t.mock.method(Partner, 'findOne', () => ({ select: () => ({ lean: async () => null }) }));
  t.mock.method(PartnershipApplication, 'countDocuments', async () => 0);
  t.mock.method(PartnershipApplication, 'create', async (d) => ({ ...d, _id: 'a1' }));
  const receipt = t.mock.method(mailer, 'sendPartnershipReceipt', async () => true);
  const req = { session: { partnershipFormShownAt: Date.now() - 60000, captcha: { answer: 5, createdAt: Date.now() } }, body: { ...goodForm(), captchaAnswer: '5' }, ip: '1.1.1.1' };
  const res = fakeRes();
  await partnershipController.submitApplication(req, res);
  assert.equal(res.redirected, '/partnerships/received');
  assert.equal(receipt.mock.callCount(), 1);
  const page = fakeRes();
  partnershipController.received(req, page);
  assert.equal(page.rendered.v, 'pages/partnership-received');
  const again = fakeRes();
  partnershipController.received(req, again);
  assert.equal(again.redirected, '/partnerships', 'the receipt is shown once');
});

// ---------- views ----------
test('partner strip shows logos, falls back to names, escapes text and stays quiet when empty', async () => {
  const partners = [
    { name: 'Bright Studio', websiteUrl: 'https://brightstudio.com/', logoUrl: '/media/0/64b7f0f0f0f0f0f0f0f0f0a1', description: 'Prints', showOnLanding: true },
    { name: '<script>x</script> Co', websiteUrl: 'https://evil.example.org/', logoUrl: '', showOnLanding: false }
  ];
  const footer = await render('partials/partners-strip.ejs', { variant: 'footer', partners });
  assert.match(footer, /<img src="\/media\/0\/64b7f0f0f0f0f0f0f0f0f0a1" alt="Bright Studio"/);
  assert.match(footer, /rel="noopener noreferrer"/);
  assert.match(footer, /&lt;script&gt;x&lt;\/script&gt; Co/);
  assert.doesNotMatch(footer, /<script>x/);
  assert.match(footer, /not an endorsement/);
  const landing = await render('partials/partners-strip.ejs', { variant: 'landing', partners });
  assert.match(landing, /Bright Studio/);
  assert.doesNotMatch(landing, /Co<\/span>/, 'partners hidden from the landing page are left out');
  assert.equal((await render('partials/partners-strip.ejs', { variant: 'footer', partners: [] })).trim(), '');
  assert.match(await render('partials/partners-strip.ejs', { variant: 'landing', partners: [] }), /Become a partner/);
});

test('public footer, landing page and about page expose partners and partnership links', async () => {
  const partners = [{ name: 'Bright Studio', websiteUrl: 'https://brightstudio.com/', logoUrl: '', showOnLanding: true }];
  const footer = await render('partials/site-footer.ejs', { partners });
  for (const href of ['/partnerships', '/partnerships/terms', '/partnerships/brand-guidelines']) assert.ok(footer.includes(`href="${href}"`), href);
  assert.match(footer, /partners-strip--footer/);
  const appFooter = await render('partials/app-footer.ejs', { partners, currentUser: { id: 'u', role: 'user', name: 'A B' } });
  assert.match(appFooter, /href="\/partnerships\/terms"/);
  assert.match(appFooter, /Bright Studio/);
  const once = (html) => (html.match(/partners-strip--/g) || []).length;
  assert.equal(once(await render('partials/site-footer.ejs', { partners, showPartners: true })), 0, 'footer skips its strip when the page already lists partners');
  assert.equal(once(footer), 1);
});

test('partnership overview, application form and receipt render with every required element', async () => {
  const overview = await render('pages/partnerships.ejs', { title: 'Partnerships', description: 'd', pagePath: '/partnerships', showPartners: true, partners: [{ name: 'Bright Studio', websiteUrl: 'https://b.com/', logoUrl: '', showOnLanding: true }] });
  assert.match(overview, /href="\/partnerships\/apply"/);
  assert.match(overview, /Bright Studio/);
  assert.equal((overview.match(/partners-strip--/g) || []).length, 1, 'partners are listed once on the overview page');
  assert.match(overview, /no fee|does not charge/i);
  const form = await render('pages/partnership-apply.ejs', {
    title: 'Apply', description: 'd', pagePath: '/partnerships/apply', organizationTypes: partnerships.ORGANIZATION_TYPES,
    termsVersion: partnerships.PARTNERSHIP_TERMS_VERSION, captcha: { a: 2, b: 3 }, turnstileSiteKey: '', form: { organizationName: 'Kept "value"' }
  });
  assert.match(form, /action="\/partnerships\/apply"/);
  assert.match(form, /name="_csrf" value="tok"/);
  for (const key of partnerships.ATTESTATIONS) assert.match(form, new RegExp(`name="${key}" required`), key);
  for (const name of ['organizationName', 'organizationType', 'websiteUrl', 'contactEmail', 'description', 'collaboration', 'captchaAnswer', 'companyFax']) assert.match(form, new RegExp(`name="${name}"`), name);
  assert.match(form, /value="Kept &#34;value&#34;"/, 'saved input is escaped when the form is re-shown');
  assert.match(form, /href="\/partnerships\/terms"/);
  const received = await render('pages/partnership-received.ejs', { title: 'Received', pagePath: '/x', noIndex: true, receipt: { reference: 'CWP-ABCD1234', email: 'a@b.com', organization: 'Bright' } });
  assert.match(received, /CWP-ABCD1234/);
});

test('legal pages render: partnership terms, brand guidelines, and the privacy / terms cross-references', async () => {
  const partners = [{ name: 'Bright', websiteUrl: 'https://b.com/', logoUrl: '', showOnLanding: true }];
  const pages = {};
  for (const p of ['/partnerships/terms', '/partnerships/brand-guidelines', '/privacy', '/terms']) {
    let captured;
    await webController.infoPage({ path: p, protocol: 'https', get: () => 'crowdwide.example.org' }, { render: (view, data) => { captured = { view, data }; } });
    assert.equal(captured.view, 'pages/info');
    pages[p] = await render('pages/info.ejs', { ...captured.data, partners });
  }
  const terms = pages['/partnerships/terms'];
  for (const heading of ['Applying', 'What a partnership is not', 'Licence to the Partner', 'Licence to Crowdwide', 'Data and privacy', 'Ending the partnership', 'Liability and indemnity', 'Governing law']) {
    assert.ok(terms.includes(heading), heading);
  }
  assert.match(terms, /<span class="principle-number">15<\/span>/, 'two-digit section numbers');
  assert.match(terms, new RegExp(partnerships.PARTNERSHIP_TERMS_VERSION));
  assert.match(pages['/partnerships/brand-guidelines'], /Crowdwide_logo_512\.png/);
  assert.match(pages['/partnerships/brand-guidelines'], /partners-strip--inline/);
  assert.match(pages['/privacy'], /Partnership requests and partner listings/);
  assert.match(pages['/privacy'], /180 days/);
  assert.match(pages['/privacy'], /Last updated October 2026/);
  assert.match(pages['/terms'], /<h2>Partnerships<\/h2>/);
  // The About page lists partners too (flag set by the controller; rendered here without the stats lookup).
  const about = await render('pages/info.ejs', { title: 'About', description: 'd', pagePath: '/about', heading: 'h', intro: 'i', sections: [], showPartners: true, partners });
  assert.match(about, /partners-strip--inline/);
});

test('brand guideline links cannot be hijacked through the Host header', () => {
  const { partnershipPages } = require('../src/utils/partnershipPages');
  const html = JSON.stringify(partnershipPages({ appUrl: 'http://evil.com"><script>alert(1)</script>' }));
  assert.doesNotMatch(html, /<script>alert/);
});

test('admin partnership and partner-logo panels render requests, decisions and partner cards', async () => {
  const html = await render('partials/admin-partnerships.ejs', {
    partnershipTermsVersion: 'v1', organizationTypeLabels: { company: 'Company or business' },
    partnershipApplications: [
      { _id: 'a1', reference: 'CWP-1', status: 'pending', organizationName: 'Bright <b>Studio</b>', organizationType: 'company', websiteUrl: 'https://b.com/', contactName: 'Asha', contactEmail: 'asha@b.com', emailMatchesWebsite: true, description: 'About', collaboration: 'Plan', termsVersion: 'v1', attestedAt: new Date(), createdAt: new Date(), ipAddress: '1.2.3.4', logoLink: 'https://b.com/logo.png' },
      { _id: 'a2', reference: 'CWP-2', status: 'rejected', organizationName: 'Spam Co', contactEmail: 'x@y.com', decisionReason: 'Gambling site', reviewedAt: new Date(), createdAt: new Date() }
    ],
    adminPartners: [{ _id: 'p1', name: 'Acme', websiteUrl: 'https://acme.org/', logoUrl: '', isVisible: false, displayOrder: 5, showOnLanding: true }]
  });
  assert.match(html, /action="\/admin\/partnerships\/a1\/review"/);
  assert.match(html, /name="decision" value="approved"/);
  assert.match(html, /name="decision" value="rejected"/);
  assert.match(html, /Bright &lt;b&gt;Studio&lt;\/b&gt;/);
  assert.match(html, /Email matches website/);
  assert.match(html, /Gambling site/);
  assert.match(html, /enctype="multipart\/form-data"/);
  assert.match(html, /action="\/admin\/partners\/p1"/);
  assert.match(html, /action="\/admin\/partners\/p1\/delete"/);
  assert.match(html, /Needs logo/);
  assert.match(html, /name="logo" accept="image\/png,image\/jpeg,image\/webp"/);
});

// ---------- permissions ----------
test('admin partnership and ambassador routes are admin-only, panel-password protected and CSRF checked', () => {
  const router = require('../src/routes/web');
  const wanted = ['/admin/partnerships/:id/review', '/admin/partners', '/admin/partners/:id', '/admin/partners/:id/visibility', '/admin/partners/:id/delete', '/admin/brand-ambassadors', '/admin/brand-ambassadors/:id', '/admin/brand-ambassadors/:id/delete'];
  for (const route of wanted) {
    const layer = router.stack.find((l) => l.route?.path === route && l.route.methods.post);
    assert.ok(layer, `${route} is registered`);
    const handlers = layer.route.stack.map((s) => s.handle);
    assert.ok(handlers.includes(requireAdmin), `${route} requires admin`);
    assert.ok(handlers.some((h) => h.name === 'csrfSynchronisedProtection' || /csrf/i.test(h.name)), `${route} checks CSRF`);
    assert.ok(handlers.length >= 5, `${route} also requires sign-in, verification and the panel password`);
  }
  const apply = router.stack.find((l) => l.route?.path === '/partnerships/apply' && l.route.methods.post);
  assert.ok(apply.route.stack.some((s) => /csrf/i.test(s.handle.name)), 'public form is CSRF protected');
  assert.ok(apply.route.stack.length >= 3, 'public form is rate limited');
});
