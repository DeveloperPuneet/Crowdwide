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
const REPORT_EVIDENCE_LIMIT = 2 * 1024 * 1024;

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

function validatePostUpload(req, res, next) {
  if (!req.files?.length) return next();
  for (const file of req.files) {
    const kind = classify(file);
    if (file.size >= mediaLimits[kind]) {
      req.session.flash = { type: 'error', message: `${kind} files must be smaller than ${kind === 'image' ? '1.5MB' : kind === 'video' ? '4MB' : '2MB'}.` };
      return res.redirect('/dashboard');
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
    // Fails OPEN: a scanner outage (timeout, connection refused) blocks
    // the scan, not the upload - consistent with how mailer/push/link
    // preview degrade elsewhere in this app. A stricter deployment that
    // wants to fail closed instead should treat this catch block as the
    // place to change - see Known Gaps in todo.txt for the trade-off.
    logger.error('Virus scan could not be completed; allowing the upload through', error);
    next();
  }
}

function handleUploadError(error, req, res, next) {
  if (!error) return next();
  req.session.flash = { type: 'error', message: error.code === 'LIMIT_FILE_SIZE' ? 'That file is larger than the allowed limit.' : 'We could not process that upload.' };
  if (req.path.startsWith('/settings')) return res.redirect('/settings/profile');
  if (req.path.includes('/manage') || req.path.includes('/report')) return res.redirect(req.get('referer') || '/dashboard');
  res.redirect('/dashboard');
}

module.exports = { postUpload, profileUpload, communityUpload, reportUpload, validatePostUpload, validateProfileUpload, validateCommunityUpload, validateReportUpload, scanUploadsForViruses, handleUploadError };
