const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validatePostUpload,
  validateProfileUpload,
  validateCommunityUpload
} = require('../src/middleware/uploads');

function fakeReq(overrides = {}) {
  return { session: {}, path: '/dashboard', get: () => '', ...overrides };
}

function fakeRes() {
  const res = { redirected: null };
  res.redirect = (to) => { res.redirected = to; return res; };
  return res;
}

test('validatePostUpload lets a request with no files through', () => {
  const req = fakeReq({ files: [] });
  const res = fakeRes();
  let calledNext = false;
  validatePostUpload(req, res, () => { calledNext = true; });
  assert.equal(calledNext, true);
  assert.equal(res.redirected, null);
});

test('validatePostUpload rejects an image at/over its 1.5MB limit', () => {
  const req = fakeReq({ files: [{ mimetype: 'image/png', size: 1.5 * 1024 * 1024 }] });
  const res = fakeRes();
  let calledNext = false;
  validatePostUpload(req, res, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.equal(res.redirected, '/dashboard');
  assert.match(req.session.flash.message, /image files must be smaller than 1\.5MB/i);
});

test('validatePostUpload accepts an image safely under the limit and tags mediaKind', () => {
  const file = { mimetype: 'image/jpeg', size: 1024 };
  const req = fakeReq({ files: [file] });
  const res = fakeRes();
  let calledNext = false;
  validatePostUpload(req, res, () => { calledNext = true; });
  assert.equal(calledNext, true);
  assert.equal(file.mediaKind, 'image');
});

test('validatePostUpload rejects a video at/over its 4MB limit', () => {
  const req = fakeReq({ files: [{ mimetype: 'video/mp4', size: 4 * 1024 * 1024 }] });
  const res = fakeRes();
  let calledNext = false;
  validatePostUpload(req, res, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.match(req.session.flash.message, /video files must be smaller than 4MB/i);
});

test('validateProfileUpload rejects an oversized profile picture', () => {
  const req = fakeReq({
    path: '/settings/profile',
    files: { profilePicture: [{ size: 1.5 * 1024 * 1024 }] }
  });
  const res = fakeRes();
  let calledNext = false;
  validateProfileUpload(req, res, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.equal(res.redirected, '/settings/profile');
  assert.match(req.session.flash.message, /profile pictures must be smaller than 1\.5MB/i);
});

test('validateProfileUpload rejects an oversized banner independently of the picture', () => {
  const req = fakeReq({
    path: '/settings/profile',
    files: { profilePicture: [{ size: 1024 }], bannerImage: [{ size: 1.5 * 1024 * 1024 }] }
  });
  const res = fakeRes();
  let calledNext = false;
  validateProfileUpload(req, res, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.match(req.session.flash.message, /banners must be smaller than 1\.5MB/i);
});

test('validateProfileUpload passes when both files are within their limits', () => {
  const req = fakeReq({
    files: { profilePicture: [{ size: 1024 }], bannerImage: [{ size: 1024 }] }
  });
  const res = fakeRes();
  let calledNext = false;
  validateProfileUpload(req, res, () => { calledNext = true; });
  assert.equal(calledNext, true);
});

test('validateCommunityUpload rejects an oversized banner (2MB limit)', () => {
  const req = fakeReq({
    files: { bannerImage: [{ size: 2 * 1024 * 1024 }] }
  });
  const res = fakeRes();
  let calledNext = false;
  validateCommunityUpload(req, res, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.match(req.session.flash.message, /community banners must be smaller than 2MB/i);
});

test('validateCommunityUpload passes when no files were submitted', () => {
  const req = fakeReq({ files: undefined });
  const res = fakeRes();
  let calledNext = false;
  validateCommunityUpload(req, res, () => { calledNext = true; });
  assert.equal(calledNext, true);
});

test('validateReportUpload rejects an oversized evidence file', () => {
  const req = fakeReq({ file: { size: 2 * 1024 * 1024 } });
  const res = fakeRes();
  let calledNext = false;
  require('../src/middleware/uploads').validateReportUpload(req, res, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.match(req.session.flash.message, /evidence screenshots must be smaller than 2MB/i);
});

test('validateReportUpload passes when no evidence file was submitted', () => {
  const req = fakeReq({ file: undefined });
  const res = fakeRes();
  let calledNext = false;
  require('../src/middleware/uploads').validateReportUpload(req, res, () => { calledNext = true; });
  assert.equal(calledNext, true);
});

test('validateReportUpload passes for an evidence file within the limit', () => {
  const req = fakeReq({ file: { size: 1024 } });
  const res = fakeRes();
  let calledNext = false;
  require('../src/middleware/uploads').validateReportUpload(req, res, () => { calledNext = true; });
  assert.equal(calledNext, true);
});
