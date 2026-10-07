const multer = require('multer');
const { scanRequestFiles } = require('../services/virusScan');
const logger = require('../services/logger');
const storage = multer.memoryStorage();

const mediaLimits = {
  image: 1.5 * 1024 * 1024,
  video: 4 * 1024 * 1024,
  audio: 2 * 1024 * 1024
};
const PROFILE_PICTURE_LIMIT = 1.5 * 1024 * 1024;
const PROFILE_BANNER_LIMIT = 1.5 * 1024 * 1024;
const COMMUNITY_AVATAR_LIMIT = 1.5 * 1024 * 1024;
const COMMUNITY_BANNER_LIMIT = 2 * 1024 * 1024;
const ADVERTISER_LOGO_LIMIT = 1.5 * 1024 * 1024;
const ADVERTISER_BANNER_LIMIT = 2 * 1024 * 1024;
const REPORT_EVIDENCE_LIMIT = 2 * 1024 * 1024;
const GROUP_AVATAR_LIMIT = 1.5 * 1024 * 1024;
const AD_BANNER_LIMIT = 2 * 1024 * 1024;
const CHAT_ATTACHMENT_LIMIT = 3 * 1024 * 1024;

function classify(file) {
  if (file.mimetype.startsWith('image/')) return 'image';
  if (file.mimetype.startsWith('video/')) return 'video';
  if (file.mimetype.startsWith('audio/')) return 'audio';
  return null;
}

const postUpload = multer({
  storage,
  limits: { fileSize: 4 * 1024 * 1024, files: 2 },
  fileFilter: (req, file, callback) => callback(null, Boolean(classify(file)))
}).array('media', 2);

// Profile picture + profile banner can be submitted together from Settings.
const profileUpload = multer({
  storage,
  limits: { fileSize: PROFILE_BANNER_LIMIT + 1, files: 2 },
  fileFilter: (req, file, callback) => callback(null, file.mimetype.startsWith('image/'))
}).fields([{ name: 'profilePicture', maxCount: 1 }, { name: 'bannerImage', maxCount: 1 }]);

// Community avatar (pfp) + banner, submitted together from community management.
const communityUpload = multer({
  storage,
  limits: { fileSize: COMMUNITY_BANNER_LIMIT + 1, files: 2 },
  fileFilter: (req, file, callback) => callback(null, file.mimetype.startsWith('image/'))
}).fields([{ name: 'avatarImage', maxCount: 1 }, { name: 'bannerImage', maxCount: 1 }]);

// Optional single evidence screenshot attached to a report.
const reportUpload = multer({
  storage,
  limits: { fileSize: REPORT_EVIDENCE_LIMIT + 1, files: 1 },
  fileFilter: (req, file, callback) => callback(null, file.mimetype.startsWith('image/'))
}).single('evidence');

// Group chat picture (one image), set from the group's info page.
const groupUpload = multer({
  storage,
  limits: { fileSize: GROUP_AVATAR_LIMIT + 1, files: 1 },
  fileFilter: (req, file, callback) => callback(null, file.mimetype.startsWith('image/'))
}).single('avatar');

const advertisementBannerUpload = multer({
  storage,
  limits: { fileSize: AD_BANNER_LIMIT + 1, files: 1 },
  fileFilter: (req, file, callback) => callback(null, file.mimetype.startsWith('image/'))
}).single('banner');

const advertiserApplicationUpload = multer({
  storage,
  limits: { fileSize: ADVERTISER_BANNER_LIMIT + 1, files: 2 },
  fileFilter: (req, file, callback) => callback(null, file.mimetype.startsWith('image/'))
}).fields([{ name: 'logo', maxCount: 1 }, { name: 'banner', maxCount: 1 }]);

const chatAttachmentUpload = multer({
  storage,
  limits: { fileSize: CHAT_ATTACHMENT_LIMIT, files: 1 }
}).single('attachment');

function detectChatAttachmentType(buffer, declaredType) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) && declaredType === 'image/jpeg') return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && declaredType === 'image/png') return 'image/png';
  if (['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii')) && declaredType === 'image/gif') return 'image/gif';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP' && declaredType === 'image/webp') return 'image/webp';
  if (declaredType === 'video/mp4' && buffer.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4';
  if (declaredType === 'video/webm' && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/webm';
  if (declaredType === 'video/quicktime' && buffer.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/quicktime';
  if (buffer.subarray(0, 5).toString('ascii') === '%PDF-' && declaredType === 'application/pdf') return 'application/pdf';
  if (declaredType === 'text/plain' && !buffer.includes(0)) {
    try { new TextDecoder('utf-8', { fatal: true }).decode(buffer); return 'text/plain'; } catch (error) { return null; }
  }
  return null;
}

function validateChatAttachment(req, res, next) {
  if (!req.file) return next();
  const contentType = detectChatAttachmentType(req.file.buffer, req.file.mimetype);
  if (req.file.size >= CHAT_ATTACHMENT_LIMIT || !contentType) {
    req.session.flash = { type: 'error', message: 'Choose a supported image, PDF, or text file smaller than 3 MB.' };
    return res.redirect(req.get('referer') || '/messages');
  }
  req.file.safeContentType = contentType;
  req.file.safeFilename = String(req.file.originalname || 'attachment').replace(/[\\/\r\n"\0]/g, '_').slice(0, 180) || 'attachment';
  next();
}

function validateGroupUpload(req, res, next) {
  if (req.file && req.file.size >= GROUP_AVATAR_LIMIT) {
    req.session.flash = { type: 'error', message: 'Group pictures must be smaller than 1.5MB.' };
    return res.redirect(req.get('referer') || '/groups');
  }
  next();
}

function validatePostUpload(req, res, next) {
  if (!req.files?.length) return next();
  for (const file of req.files) {
    const kind = classify(file);
    if (file.size >= mediaLimits[kind]) {
      req.session.flash = { type: 'error', message: `${kind} files must be smaller than ${kind === 'image' ? '1.5MB' : kind === 'video' ? '4MB' : '2MB'}.` };
      return res.redirect(req.get('referer') || req.uploadReturnTo || '/dashboard');
    }
    file.mediaKind = kind;
  }
  next();
}

function validateProfileUpload(req, res, next) {
  const picture = req.files?.profilePicture?.[0];
  const banner = req.files?.bannerImage?.[0];
  if (picture && picture.size >= PROFILE_PICTURE_LIMIT) {
    req.session.flash = { type: 'error', message: 'Profile pictures must be smaller than 1.5MB.' };
    return res.redirect('/settings/profile');
  }
  if (banner && banner.size >= PROFILE_BANNER_LIMIT) {
    req.session.flash = { type: 'error', message: 'Profile banners must be smaller than 1.5MB.' };
    return res.redirect('/settings/profile');
  }
  next();
}

function validateCommunityUpload(req, res, next) {
  const avatar = req.files?.avatarImage?.[0];
  const banner = req.files?.bannerImage?.[0];
  if (avatar && avatar.size >= COMMUNITY_AVATAR_LIMIT) {
    req.session.flash = { type: 'error', message: 'Community profile pictures must be smaller than 1.5MB.' };
    return res.redirect('back');
  }
  if (banner && banner.size >= COMMUNITY_BANNER_LIMIT) {
    req.session.flash = { type: 'error', message: 'Community banners must be smaller than 2MB.' };
    return res.redirect('back');
  }
  next();
}

async function validateAdvertiserApplicationUpload(req, res, next) {
  const logo = req.files?.logo?.[0];
  const banner = req.files?.banner?.[0];
  if (logo && logo.size >= ADVERTISER_LOGO_LIMIT) {
    req.session.flash = { type: 'error', message: 'Advertiser logos must be smaller than 1.5MB.' };
    return res.redirect('/advertising');
  }
  if (banner && banner.size >= ADVERTISER_BANNER_LIMIT) {
    req.session.flash = { type: 'error', message: 'Advertiser banners must be smaller than 2MB.' };
    return res.redirect('/advertising');
  }
  try {
    const { getImageSize } = require('../services/storage');
    for (const file of [logo, banner].filter(Boolean)) {
      if (!await getImageSize(file.buffer)) {
        req.session.flash = { type: 'error', message: `Choose a valid image for the advertiser ${file.fieldname}.` };
        return res.redirect('/advertising');
      }
      file.mediaKind = 'image';
    }
    return next();
  } catch (error) {
    logger.error('Advertiser application image validation failed', error);
    req.session.flash = { type: 'error', message: 'The advertiser images could not be validated.' };
    return res.redirect('/advertising');
  }
}

async function validateAdvertisementBanner(req, res, next) {
  if (!req.file) return next();
  if (req.file.size >= AD_BANNER_LIMIT) {
    req.session.flash = { type: 'error', message: 'Advertisement banners must be smaller than 2MB.' };
    return res.redirect('/advertising');
  }
  try {
    const { getImageSize } = require('../services/storage');
    const size = await getImageSize(req.file.buffer);
    if (!size) {
      req.session.flash = { type: 'error', message: 'Choose a valid image file for the advertisement banner.' };
      return res.redirect('/advertising');
    }
    req.file.mediaKind = 'image';
    next();
  } catch (error) {
    logger.error('Advertisement banner validation failed', error);
    req.session.flash = { type: 'error', message: 'The advertisement banner could not be validated.' };
    res.redirect('/advertising');
  }
}

function validateReportUpload(req, res, next) {
  if (req.file && req.file.size >= REPORT_EVIDENCE_LIMIT) {
    req.session.flash = { type: 'error', message: 'Evidence screenshots must be smaller than 2MB.' };
    return res.redirect(req.get('referer') || '/dashboard');
  }
  next();
}

async function scanUploadsForViruses(req, res, next) {
  try {
    const infectedFilename = await scanRequestFiles(req);
    if (infectedFilename) {
      req.session.flash = { type: 'error', message: `"${infectedFilename}" was flagged by virus scanning and was not uploaded.` };
      return res.redirect(req.get('referer') || '/dashboard');
    }
    next();
  } catch (error) {
    logger.error('Virus scan could not be completed', error);
    if (process.env.CLAMAV_FAIL_OPEN === 'true') return next();
    req.session.flash = { type: 'error', message: 'Uploads are temporarily unavailable because security scanning could not be completed.' };
    res.redirect(req.get('referer') || '/dashboard');
  }
}

function handleUploadError(error, req, res, next) {
  if (!error) return next();
  req.session.flash = { type: 'error', message: error.code === 'LIMIT_FILE_SIZE' ? 'That file is larger than the allowed limit.' : 'We could not process that upload.' };
  if (req.path.startsWith('/groups')) return res.redirect(req.get('referer') || '/groups');
  if (req.path.startsWith('/messages')) return res.redirect(req.get('referer') || '/messages');
  if (req.path.startsWith('/settings')) return res.redirect('/settings/profile');
  if (req.path.startsWith('/advertising')) return res.redirect('/advertising');
  if (req.path.includes('/manage') || req.path.includes('/report')) return res.redirect(req.get('referer') || '/dashboard');
  res.redirect('/dashboard');
}

module.exports = { postUpload, profileUpload, communityUpload, reportUpload, groupUpload, advertisementBannerUpload, advertiserApplicationUpload, chatAttachmentUpload, validateAdvertiserApplicationUpload, validateAdvertisementBanner, validateChatAttachment, detectChatAttachmentType, validateGroupUpload, validatePostUpload, validateProfileUpload, validateCommunityUpload, validateReportUpload, scanUploadsForViruses, handleUploadError };
