const mongoose = require('mongoose');
const { GridFSBucket, ObjectId } = require('mongodb');

function getBucket() {
  if (!mongoose.connection.db) throw new Error('MongoDB is not connected.');
  return new GridFSBucket(mongoose.connection.db, { bucketName: 'crowdwideMedia' });
}

function uploadBuffer(buffer, filename, contentType, metadata = {}) {
  return new Promise((resolve, reject) => {
    const upload = getBucket().openUploadStream(filename, { contentType, metadata });
    upload.on('error', reject);
    upload.on('finish', () => resolve({ id: upload.id.toString(), filename, contentType }));
    upload.end(buffer);
  });
}

function streamFile(id, res) {
  if (!ObjectId.isValid(id)) return res.status(404).end();
  const bucket = getBucket();
  bucket.find({ _id: new ObjectId(id) }).toArray().then((files) => {
    const file = files[0];
    if (!file) return res.status(404).end();
    res.type(file.contentType || 'application/octet-stream');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    bucket.openDownloadStream(file._id).on('error', () => res.status(404).end()).pipe(res);
  }).catch(() => res.status(404).end());
}

module.exports = { uploadBuffer, streamFile };
