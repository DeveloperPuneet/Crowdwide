const fs = require('fs');
const path = require('path');
const multer = require('multer');

const uploadDirectory = path.join(__dirname, '../../public/uploads');
fs.mkdirSync(uploadDirectory, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadDirectory,
  filename: (req, file, callback) => callback(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname).toLowerCase()}`)
});

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
  limits: { fileSize: 4 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => callback(null, Boolean(classify(file)))
}).single('media');

const profileUpload = multer({
  storage,
  limits: { fileSize: mediaLimits.image + 1, files: 1 },
  fileFilter: (req, file, callback) => callback(null, file.mimetype.startsWith('image/'))
}).single('profilePicture');

function validatePostUpload(req, res, next) {
  if (!req.file) return next();
  const kind = classify(req.file);
  if (req.file.size >= mediaLimits[kind]) {
    fs.rm(req.file.path, () => {});
    req.session.flash = { type: 'error', message: `${kind} files must be smaller than ${kind === 'image' ? '1.5MB' : kind === 'video' ? '4MB' : '2MB'}.` };
    return res.redirect('/dashboard');
  }
  req.file.mediaKind = kind;
  next();
}

function validateProfileUpload(req, res, next) {
  if (req.file && req.file.size >= mediaLimits.image) {
    fs.rm(req.file.path, () => {});
    req.session.flash = { type: 'error', message: 'Profile pictures must be smaller than 1.5MB.' };
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
