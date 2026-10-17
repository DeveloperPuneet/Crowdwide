const AuditLog = require('../models/AuditLog');
const Partner = require('../models/Partner');
const { uploadBuffer, mediaUrl } = require('../services/storageCluster');
const { generateChallenge, verifyChallenge, verifyTurnstile, turnstileEnabled, turnstileSiteKey, MIN_FILL_MS } = require('../services/captcha');
const partnerships = require('../services/partnerships');
const mailer = require('../services/mailer');
const logger = require('../services/logger');

const { PartnershipError, ORGANIZATION_TYPES, PARTNERSHIP_TERMS_VERSION } = partnerships;
const FORM_FIELDS = ['organizationName', 'organizationType', 'websiteUrl', 'logoLink', 'displayUrl', 'country', 'contactName', 'contactRole', 'contactEmail', 'description', 'collaboration'];

const flash = (req, type, message) => { req.session.flash = { type, message }; };
const audit = (req, action, target, details = {}) => AuditLog.create({
  actor: req.roleUser._id, action, targetType: 'partnership', target, details, ipAddress: req.ip, userAgent: req.get('user-agent')
});

// ---- Public ----

exports.overview = async (req, res) => {
  res.render('pages/partnerships', {
    title: 'Partnerships',
    pagePath: '/partnerships',
    description: 'Partner with Crowdwide: display the Crowdwide name and logo on your website and have your own name and logo shown on ours.',
    termsVersion: PARTNERSHIP_TERMS_VERSION,
    showPartners: true // the page lists partners itself, so the footer strip is skipped
  });
};

exports.applyPage = (req, res) => {
  const managed = turnstileEnabled();
  req.session.partnershipFormShownAt = Date.now();
  const form = req.session.partnershipForm || {};
  delete req.session.partnershipForm;
  res.render('pages/partnership-apply', {
    title: 'Apply to partner with Crowdwide',
    pagePath: '/partnerships/apply',
    description: 'Apply to become a Crowdwide partner.',
    organizationTypes: ORGANIZATION_TYPES,
    termsVersion: PARTNERSHIP_TERMS_VERSION,
    captcha: managed ? null : generateChallenge(req),
    turnstileSiteKey: managed ? turnstileSiteKey() : '',
    form
  });
};

exports.submitApplication = async (req, res) => {
  const remember = () => {
    const form = {};
    FORM_FIELDS.forEach((field) => { form[field] = String(req.body[field] ?? '').slice(0, 1500); });
    req.session.partnershipForm = form;
  };
  const fail = (message) => { remember(); flash(req, 'error', message); return res.redirect('/partnerships/apply'); };
  try {
    const shownAt = req.session.partnershipFormShownAt;
    delete req.session.partnershipFormShownAt;
    // Honeypot (hidden field a person never fills) and instant-submit check.
    const automated = String(req.body.companyFax ?? '').trim() !== '' || !shownAt || Date.now() - shownAt < MIN_FILL_MS;
    const humanVerified = turnstileEnabled()
      ? await verifyTurnstile(req.body['cf-turnstile-response'], req.ip)
      : verifyChallenge(req, req.body.captchaAnswer);
    if (automated || !humanVerified) return fail('That verification answer was not correct. Please try again.');

    const application = await partnerships.submitApplication(req.body, { ipAddress: req.ip });
    // Best effort: a mail outage must never lose or fail a saved request.
    mailer.sendPartnershipReceipt(application).catch((error) => logger.warn('Partnership receipt email failed', { error }));
    req.session.partnershipReceipt = { reference: application.reference, email: application.contactEmail, organization: application.organizationName };
    return res.redirect('/partnerships/received');
  } catch (error) {
    if (error instanceof PartnershipError) return fail(error.message);
    logger.error('Partnership application failed', error);
    return fail('We could not save your request right now. Please try again in a few minutes.');
  }
};

exports.received = (req, res) => {
  const receipt = req.session.partnershipReceipt;
  if (!receipt) return res.redirect('/partnerships');
  delete req.session.partnershipReceipt;
  res.render('pages/partnership-received', { title: 'Partnership request received', pagePath: '/partnerships/received', noIndex: true, receipt });
};

// ---- Admin (routes are admin-only; see routes/web.js) ----

exports.reviewApplication = async (req, res) => {
  try {
    const application = await partnerships.reviewApplication({
      applicationId: req.params.id,
      decision: String(req.body.decision || ''),
      reason: req.body.reason,
      actorId: req.roleUser._id
    });
    await audit(req, `partnership-${application.status}`, application._id, { reference: application.reference, reason: application.decisionReason });
    mailer.sendPartnershipDecision(application).catch((error) => logger.warn('Partnership decision email failed', { error }));
    flash(req, 'success', application.status === 'approved'
      ? `Approved ${application.organizationName}. Add its logo in Partner logos to show it on the site.`
      : `Rejected ${application.organizationName}. The applicant was emailed the reason.`);
    return res.redirect(application.status === 'approved' ? '/admin#partners' : '/admin#partnerships');
  } catch (error) {
    if (!(error instanceof PartnershipError)) logger.error('Partnership review failed', error);
    flash(req, 'error', error instanceof PartnershipError ? error.message : 'The decision could not be saved.');
    return res.redirect('/admin#partnerships');
  }
};

async function storeLogo(req) {
  if (!req.file) return '';
  const stored = await uploadBuffer(req.file.buffer, req.file.originalname, req.file.mimetype, { kind: 'partner-logo', owner: req.session.user.id });
  return mediaUrl(stored);
}

exports.savePartner = async (req, res) => {
  try {
    const partnerId = req.params.id || null;
    const logoUrl = await storeLogo(req);
    const partner = await partnerships.savePartner({ partnerId, input: req.body, logoUrl, actorId: req.roleUser._id });
    await audit(req, partnerId ? 'partner-updated' : 'partner-created', partner._id, { name: partner.name, visible: partner.isVisible });
    flash(req, 'success', partnerId ? `Saved ${partner.name}.` : `Added ${partner.name}.`);
  } catch (error) {
    if (!(error instanceof PartnershipError)) logger.error('Partner save failed', error);
    flash(req, 'error', error instanceof PartnershipError ? error.message : 'The partner could not be saved.');
  }
  res.redirect('/admin#partners');
};

exports.togglePartner = async (req, res) => {
  try {
    const partner = await partnerships.setPartnerVisibility(req.params.id, req.body.visible === '1');
    await audit(req, partner.isVisible ? 'partner-shown' : 'partner-hidden', partner._id, { name: partner.name });
    flash(req, 'success', `${partner.name} is now ${partner.isVisible ? 'shown on' : 'hidden from'} the site.`);
  } catch (error) {
    flash(req, 'error', error instanceof PartnershipError ? error.message : 'The partner could not be updated.');
  }
  res.redirect('/admin#partners');
};

exports.deletePartner = async (req, res) => {
  try {
    const partner = await partnerships.removePartner(req.params.id);
    await audit(req, 'partner-removed', partner._id, { name: partner.name });
    flash(req, 'success', `Removed ${partner.name}. Its logo and public listing are gone.`);
  } catch (error) {
    flash(req, 'error', error instanceof PartnershipError ? error.message : 'The partner could not be removed.');
  }
  res.redirect('/admin#partners');
};

exports.adminData = async () => {
  const PartnershipApplication = require('../models/PartnershipApplication');
  const [partnershipApplications, partners] = await Promise.all([
    PartnershipApplication.find({ status: { $in: ['pending', 'approved', 'rejected', 'ended'] } })
      .sort({ status: 1, createdAt: -1 }).limit(80).populate('reviewedBy', 'name').lean(),
    Partner.find().sort({ displayOrder: 1, name: 1 }).limit(200).lean()
  ]);
  return {
    partnershipApplications,
    adminPartners: partners,
    organizationTypeLabels: Object.fromEntries(ORGANIZATION_TYPES),
    partnershipTermsVersion: PARTNERSHIP_TERMS_VERSION,
    partnershipRetentionDays: partnerships.REJECTED_APPLICATION_RETENTION_DAYS
  };
};
