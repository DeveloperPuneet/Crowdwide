const crypto = require('crypto');
const mongoose = require('mongoose');
const Partner = require('../models/Partner');
const PartnershipApplication = require('../models/PartnershipApplication');
const { deleteFile } = require('./storageCluster');
const logger = require('./logger');

// Bump when the Partnership Terms or Brand Guidelines change materially; applicants record the
// version they accepted.
const PARTNERSHIP_TERMS_VERSION = '2026-10-16-v1';
const REJECTED_APPLICATION_RETENTION_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;
const PARTNER_CACHE_MS = 60 * 1000;
const MAX_PUBLIC_PARTNERS = 60;
const ORGANIZATION_TYPES = [
  ['company', 'Company or business'],
  ['nonprofit', 'Non-profit or charity'],
  ['educational', 'School, college or university'],
  ['community', 'Community, club or group'],
  ['media', 'Media, publisher or creator'],
  ['developer', 'Developer, app or tool'],
  ['other', 'Other organization']
];
const ATTESTATIONS = ['authorized', 'accurate', 'ownsAssets', 'acceptsTerms', 'displayConsent', 'lawfulContent'];

class PartnershipError extends Error {}

function clean(value, max) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}

// Public websites only: http(s), a real dotted hostname, no credentials, no IP literals or local names.
function parseWebsite(value, { required = true, label = 'website' } = {}) {
  const raw = clean(value, 400);
  if (!raw) {
    if (required) throw new PartnershipError(`Enter your ${label} address.`);
    return null;
  }
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`); } catch { url = null; }
  const host = url?.hostname?.toLowerCase().replace(/\.$/, '') || '';
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
  const localName = /(^|\.)(localhost|local|internal|lan|home|test|invalid|example)$/.test(host);
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || !host.includes('.') || isIp || localName || host.length > 253) {
    throw new PartnershipError(`Enter a valid public ${label} address starting with https://.`);
  }
  url.hash = '';
  return { url: url.toString().slice(0, 300), host };
}

function generateReference() {
  return `CWP-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function emailMatchesHost(email, host) {
  const domain = String(email || '').split('@')[1]?.toLowerCase() || '';
  const bare = String(host || '').replace(/^www\./, '');
  return Boolean(domain && bare && (domain === bare || domain.endsWith(`.${bare}`) || bare.endsWith(`.${domain}`)));
}

// Validates the public form and returns a clean document payload. Throws PartnershipError with a
// message that is safe to show to the applicant.
function validateApplication(input = {}) {
  const organizationName = clean(input.organizationName, 120);
  if (organizationName.length < 2) throw new PartnershipError('Enter your organization or website name.');
  const organizationType = ORGANIZATION_TYPES.some(([value]) => value === input.organizationType) ? input.organizationType : '';
  if (!organizationType) throw new PartnershipError('Choose the type of organization you represent.');
  const website = parseWebsite(input.websiteUrl);
  const logo = parseWebsite(input.logoLink, { required: false, label: 'logo link' });
  const display = parseWebsite(input.displayUrl, { required: false, label: 'page address' });
  const contactName = clean(input.contactName, 100);
  if (contactName.length < 2) throw new PartnershipError('Enter the name of the person we should contact.');
  const contactEmail = clean(input.contactEmail, 200).toLowerCase();
  if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/.test(contactEmail)) throw new PartnershipError('Enter a valid contact email address.');
  const description = clean(input.description, 1000);
  if (description.length < 30) throw new PartnershipError('Tell us a little more about your organization (at least 30 characters).');
  const collaboration = clean(input.collaboration, 1500);
  if (collaboration.length < 30) throw new PartnershipError('Describe what you would like the partnership to involve (at least 30 characters).');
  const attestations = {};
  for (const key of ATTESTATIONS) attestations[key] = input[key] === 'on' || input[key] === true;
  if (!ATTESTATIONS.every((key) => attestations[key])) {
    throw new PartnershipError('Please tick every confirmation box. They are required to submit a partnership request.');
  }
  return {
    organizationName,
    organizationType,
    websiteUrl: website.url,
    websiteHost: website.host,
    logoLink: logo?.url || '',
    displayUrl: display?.url || '',
    country: clean(input.country, 80),
    contactName,
    contactRole: clean(input.contactRole, 100),
    contactEmail,
    emailMatchesWebsite: emailMatchesHost(contactEmail, website.host),
    description,
    collaboration,
    attestations
  };
}

async function submitApplication(input, { ipAddress = '' } = {}) {
  const data = validateApplication(input);
  const [openApplication, existingPartner] = await Promise.all([
    PartnershipApplication.findOne({ websiteHost: data.websiteHost, status: { $in: ['pending', 'approved'] } }).select('_id status').lean(),
    Partner.findOne({ websiteHost: data.websiteHost }).select('_id').lean()
  ]);
  if (existingPartner || openApplication?.status === 'approved') {
    throw new PartnershipError('That website is already a Crowdwide partner.');
  }
  if (openApplication) {
    throw new PartnershipError('A partnership request for that website is already waiting for review. We will email you once it has been decided.');
  }
  const recent = await PartnershipApplication.countDocuments({
    contactEmail: data.contactEmail,
    createdAt: { $gte: new Date(Date.now() - DAY_MS) }
  });
  if (recent >= 3) throw new PartnershipError('You have already sent several requests today. Please wait for a reply before sending another.');

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await PartnershipApplication.create({
        ...data,
        reference: generateReference(),
        termsVersion: PARTNERSHIP_TERMS_VERSION,
        attestedAt: new Date(),
        ipAddress: clean(ipAddress, 80)
      });
    } catch (error) {
      if (error?.code !== 11000 || !error.keyPattern?.reference) throw error;
    }
  }
  throw new Error('Could not generate a partnership reference.');
}

// Admin decision. Approving creates a hidden Partner (name and website pre-filled) so the admin can
// add the logo and switch it on in Admin → Partner logos.
async function reviewApplication({ applicationId, decision, reason = '', actorId }) {
  if (!['approved', 'rejected'].includes(decision)) throw new PartnershipError('Choose approve or reject.');
  const cleanReason = clean(reason, 500);
  if (decision === 'rejected' && !cleanReason) throw new PartnershipError('Give a reason when rejecting an application.');
  const application = await PartnershipApplication.findOneAndUpdate(
    { _id: applicationId, status: 'pending' },
    { $set: { status: decision, decisionReason: cleanReason, reviewedAt: new Date(), reviewedBy: actorId } },
    { new: true }
  );
  if (!application) throw new PartnershipError('That application was not found or has already been decided.');
  if (decision === 'approved') {
    const partner = await Partner.create({
      name: application.organizationName,
      websiteUrl: application.websiteUrl,
      websiteHost: application.websiteHost,
      description: '',
      isVisible: false,
      application: application._id,
      createdBy: actorId
    });
    application.partner = partner._id;
    await application.save();
    clearPartnersCache();
  }
  return application;
}

function validatePartnerInput(input = {}) {
  const name = clean(input.name, 120);
  if (name.length < 2) throw new PartnershipError('Enter the partner name.');
  const website = parseWebsite(input.websiteUrl);
  const order = Number.parseInt(input.displayOrder, 10);
  return {
    name,
    websiteUrl: website.url,
    websiteHost: website.host,
    description: clean(input.description, 200),
    displayOrder: Number.isFinite(order) ? Math.max(0, Math.min(order, 9999)) : 100,
    isVisible: input.isVisible === 'on' || input.isVisible === true,
    showOnLanding: input.showOnLanding === 'on' || input.showOnLanding === true
  };
}

function mediaFile(url) {
  const match = /^\/media\/(\d+)\/([a-f\d]{24})$/i.exec(String(url || ''));
  return match ? { cluster: Number(match[1]), id: match[2] } : null;
}

async function removeLogoFile(url) {
  const file = mediaFile(url);
  if (!file) return;
  try { await deleteFile(file.cluster, file.id); } catch (error) { logger.warn('Partner logo file could not be deleted', { error }); }
}

async function savePartner({ partnerId = null, input, logoUrl = '', actorId }) {
  const data = validatePartnerInput(input);
  if (partnerId) {
    if (!mongoose.isValidObjectId(partnerId)) throw new PartnershipError('Partner not found.');
    const partner = await Partner.findById(partnerId);
    if (!partner) throw new PartnershipError('Partner not found.');
    const previousLogo = partner.logoUrl;
    Object.assign(partner, data);
    if (logoUrl) partner.logoUrl = logoUrl;
    await partner.save();
    if (logoUrl && previousLogo && previousLogo !== logoUrl) await removeLogoFile(previousLogo);
    clearPartnersCache();
    return partner;
  }
  const duplicate = await Partner.exists({ websiteHost: data.websiteHost });
  if (duplicate) throw new PartnershipError('A partner with that website already exists.');
  const partner = await Partner.create({ ...data, logoUrl, createdBy: actorId });
  clearPartnersCache();
  return partner;
}

async function setPartnerVisibility(partnerId, isVisible) {
  if (!mongoose.isValidObjectId(partnerId)) throw new PartnershipError('Partner not found.');
  const partner = await Partner.findByIdAndUpdate(partnerId, { $set: { isVisible: Boolean(isVisible) } }, { new: true });
  if (!partner) throw new PartnershipError('Partner not found.');
  clearPartnersCache();
  return partner;
}

// Ends a partnership: removes the public listing and logo, and marks the linked application ended.
async function removePartner(partnerId) {
  if (!mongoose.isValidObjectId(partnerId)) throw new PartnershipError('Partner not found.');
  const partner = await Partner.findByIdAndDelete(partnerId);
  if (!partner) throw new PartnershipError('Partner not found.');
  await removeLogoFile(partner.logoUrl);
  if (partner.application) {
    await PartnershipApplication.updateOne({ _id: partner.application }, { $set: { status: 'ended', endedAt: new Date(), partner: null } });
  }
  clearPartnersCache();
  return partner;
}

let cache = { at: 0, rows: [] };
function clearPartnersCache() { cache = { at: 0, rows: [] }; }

// Public, visible partners in display order. Cached briefly because it is read on every page render
// (footers, landing page); never throws.
async function getVisiblePartners({ now = Date.now() } = {}) {
  if (mongoose.connection.readyState !== 1) return [];
  if (now - cache.at < PARTNER_CACHE_MS) return cache.rows;
  try {
    const rows = await Partner.find({ isVisible: true })
      .sort({ displayOrder: 1, name: 1 })
      .limit(MAX_PUBLIC_PARTNERS)
      .select('name websiteUrl logoUrl description showOnLanding')
      .lean();
    cache = { at: now, rows };
    return rows;
  } catch (error) {
    logger.warn('Visible partners could not be loaded', { error });
    return cache.rows;
  }
}

// Rejected and ended applications (and their contact details) are deleted after the retention period.
async function cleanupOldApplications({ now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - REJECTED_APPLICATION_RETENTION_DAYS * DAY_MS);
  const result = await PartnershipApplication.deleteMany({
    status: { $in: ['rejected', 'ended'] },
    $or: [{ reviewedAt: { $lt: cutoff } }, { endedAt: { $lt: cutoff } }]
  });
  return { applications: result.deletedCount };
}

module.exports = {
  PARTNERSHIP_TERMS_VERSION,
  REJECTED_APPLICATION_RETENTION_DAYS,
  ORGANIZATION_TYPES,
  ATTESTATIONS,
  PartnershipError,
  parseWebsite,
  emailMatchesHost,
  validateApplication,
  submitApplication,
  reviewApplication,
  validatePartnerInput,
  savePartner,
  setPartnerVisibility,
  removePartner,
  getVisiblePartners,
  clearPartnersCache,
  cleanupOldApplications
};
