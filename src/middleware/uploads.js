const multer = require('multer');
const storage = multer.memoryStorage();

const mediaLimits = {
  image: 1.5 * 1024 * 1024,
  video: 4 * 1024 * 1024,
  audio: 2 * 1024 * 1024
};

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

const profileUpload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 + 1, files: 1 },
  fileFilter: (req, file, callback) => callback(null, file.mimetype.startsWith('image/'))
}).single('profilePicture');

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
  if (req.file && req.file.size >= 2 * 1024 * 1024) {
    req.session.flash = { type: 'error', message: 'Profile pictures must be smaller than 2MB.' };
    return res.redirect('/settings/profile');
  }
  next();
}

function handleUploadError(error, req, res, next) {
  if (!error) return next();
  req.session.flash = { type: 'error', message: error.code === 'LIMIT_FILE_SIZE' ? 'That file is larger than the allowed limit.' : 'We could not process that upload.' };
  res.redirect(req.path.startsWith('/settings') ? '/settings/profile' : '/dashboard');
}

module.exports = { postUpload, profileUpload, validatePostUpload, validateProfileUpload, handleUploadError };
