const { Storage } = require('@google-cloud/storage');
const sharp = require('sharp');

const storage = process.env.GCS_BUCKET ? new Storage({ projectId: process.env.GCS_PROJECT_ID || undefined }) : null;
const bucket = storage ? storage.bucket(process.env.GCS_BUCKET) : null;

function cdnUrl(key) {
  const base = process.env.MEDIA_CDN_URL || (process.env.GCS_BUCKET ? `https://storage.googleapis.com/${process.env.GCS_BUCKET}` : '/uploads');
  return `${base.replace(/\/$/, '')}/${key}`;
}

async function createSignedUpload({ userId, kind, contentType }) {
  if (!bucket) return { configured: false };
  const extension = contentType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin';
  const key = `media/${userId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`;
  const [url] = await bucket.file(key).getSignedUrl({ version: 'v4', action: 'write', expires: Date.now() + 15 * 60 * 1000, contentType });
  return { configured: true, url, key, publicUrl: cdnUrl(key), expiresIn: 900 };
}

async function createImageThumbnail(buffer) {
  // rotate() with no arguments applies the EXIF orientation. The WebP output
  // has no EXIF, so without it phone photos taken in portrait showed up
  // sideways in the feed.
  return sharp(buffer).rotate().resize(640, 640, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
}

// Display dimensions (after EXIF rotation) so the feed can reserve the right
// aspect ratio before the image has loaded. Returns null if unreadable.
async function getImageSize(buffer) {
  try {
    const { width, height, orientation } = await sharp(buffer).metadata();
    if (!width || !height) return null;
    return orientation >= 5 ? { width: height, height: width } : { width, height };
  } catch (error) {
    return null;
  }
}

module.exports = { createSignedUpload, createImageThumbnail, getImageSize, cdnUrl, isConfigured: () => Boolean(bucket) };
