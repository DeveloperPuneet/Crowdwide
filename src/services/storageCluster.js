/**
 * Extended storage across multiple MongoDB clusters.
 *
 * Crowdwide's primary MongoDB connection (MONGODB_URI) holds accounts, posts,
 * comments, communities, sessions, etc. Media (images/video/audio/thumbnails/
 * avatars) can grow fast and is safe to shard across extra "extended
 * storage" clusters instead of only the primary one.
 *
 * Configure extra clusters with any number of these env vars:
 *   MONGO_DB_URL_0=mongodb+srv://.../crowdwide-media-0
 *   MONGO_DB_URL_1=mongodb+srv://.../crowdwide-media-1
 *   MONGO_DB_URL_2=mongodb+srv://.../crowdwide-media-2
 *   ... MONGO_DB_URL_<n> for as many clusters as you want.
 * (MONGODB_URI_<n> is also accepted as an alias.)
 *
 * Cluster "0" is always the primary connection used by mongoose.connect() in
 * src/config/database.js, so media works out of the box even if no extra
 * clusters are configured. Every MONGO_DB_URL_<n> you add becomes another
 * shard new uploads can land on, in round-robin order, so storage capacity
 * scales horizontally by just adding another free-tier cluster and one more
 * env var - no code changes needed.
 */

const mongoose = require('mongoose');
const { GridFSBucket, ObjectId } = require('mongodb');
const logger = require('./logger');

const BUCKET_NAME = 'crowdwideMedia';

let connections = [];
let bucketCache = new Map();
let ready = false;

function discoverExtraClusterUris() {
  const uris = [];
  let index = 0;
  while (true) {
    const uri = process.env[`MONGO_DB_URL_${index}`] || process.env[`MONGODB_URI_${index}`];
    if (!uri) break;
    uris.push(uri);
    index += 1;
  }
  return uris;
}

/**
 * Connects every configured extended-storage cluster. Cluster 0 is always
 * the app's primary mongoose connection. Call once at boot, after the
 * primary connection is established.
 */
async function initStorageClusters() {
  connections = [mongoose.connection];
  bucketCache = new Map();

  const extraUris = discoverExtraClusterUris();
  for (const [offset, uri] of extraUris.entries()) {
    const clusterIndex = offset + 1;
    try {
      const connection = mongoose.createConnection(uri, { serverSelectionTimeoutMS: 8000 });
      await connection.asPromise();
      connections.push(connection);
      logger.info(`Crowdwide extended storage: cluster ${clusterIndex} connected.`);
    } catch (error) {
      logger.warn(`Crowdwide extended storage: cluster ${clusterIndex} failed to connect. It will be skipped.`, error);
    }
  }

  ready = true;
  const extendedCount = connections.length - 1;
  console.log(extendedCount > 0
    ? `Crowdwide media storage spans ${connections.length} clusters (1 primary + ${extendedCount} extended).`
    : 'Crowdwide media storage is using only the primary MongoDB cluster. Add MONGO_DB_URL_1, MONGO_DB_URL_2, ... to extend it.');
}

function clusterCount() {
  return Math.max(connections.length, 1);
}

function isReady() {
  return ready;
}

function getBucket(clusterIndex) {
  const index = Number.isInteger(clusterIndex) && clusterIndex >= 0 && clusterIndex < connections.length ? clusterIndex : 0;
  if (bucketCache.has(index)) return bucketCache.get(index);
  const connection = connections[index] || mongoose.connection;
  if (!connection.db) throw new Error(`Storage cluster ${index} is not connected yet.`);
  const bucket = new GridFSBucket(connection.db, { bucketName: BUCKET_NAME });
  bucketCache.set(index, bucket);
  return bucket;
}

// A tiny counter collection on the primary cluster keeps round-robin
// selection balanced across server restarts and multiple app instances.
const counterSchema = new mongoose.Schema({ _id: String, value: { type: Number, default: 0 } }, { versionKey: false });
const StorageCounter = mongoose.models.StorageCounter || mongoose.model('StorageCounter', counterSchema, 'storage_counters');

async function nextClusterIndex() {
  const total = clusterCount();
  if (total <= 1) return 0;
  try {
    const counter = await StorageCounter.findOneAndUpdate(
      { _id: 'media' },
      { $inc: { value: 1 } },
      { upsert: true, new: true }
    );
    return counter.value % total;
  } catch (error) {
    // Primary cluster hiccup - fall back to a random shard so uploads don't fail.
    return Math.floor(Math.random() * total);
  }
}

/**
 * Uploads a buffer to whichever cluster is next in the rotation and returns
 * everything needed to build a media URL and retrieve it later.
 */
async function uploadBuffer(buffer, filename, contentType, metadata = {}) {
  const cluster = await nextClusterIndex();
  const bucket = getBucket(cluster);
  return new Promise((resolve, reject) => {
    const upload = bucket.openUploadStream(filename, { contentType, metadata });
    upload.on('error', reject);
    upload.on('finish', () => resolve({ id: upload.id.toString(), cluster, filename, contentType }));
    upload.end(buffer);
  });
}

/**
 * Parses an HTTP Range header ("bytes=0-1023", "bytes=500-", "bytes=-500")
 * against a file of `size` bytes. Returns { start, end } (inclusive), null
 * when there is no usable Range header (serve the whole file), or
 * 'unsatisfiable' when the range lies outside the file.
 */
function parseRange(header, size) {
  if (!header || !/^bytes=/i.test(header) || size <= 0) return null;
  const first = header.slice(6).split(',')[0].trim();
  const match = /^(\d*)-(\d*)$/.exec(first);
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start;
  let end;
  if (match[1] === '') {
    // suffix range: the last N bytes
    const suffix = Number(match[2]);
    if (!suffix) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

/**
 * Streams a stored file to an Express response, with HTTP Range support.
 * Range support is what lets browsers seek inside a video and is required
 * for video to play at all in Safari/iOS; without it a <video> can only
 * play from the very beginning, if at all.
 */
function streamFile(clusterIndex, id, req, res) {
  // Backwards compatible with the old (cluster, id, res) signature.
  if (res === undefined) { res = req; req = null; }
  if (!ObjectId.isValid(id)) return res.status(404).end();
  let bucket;
  try {
    bucket = getBucket(clusterIndex);
  } catch (error) {
    return res.status(404).end();
  }
  bucket.find({ _id: new ObjectId(id) }).toArray().then((files) => {
    const file = files[0];
    if (!file) return res.status(404).end();
    const size = file.length;
    res.type(file.contentType || 'application/octet-stream');
    res.set({ 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes' });

    const range = parseRange(req?.headers?.range, size);
    if (range === 'unsatisfiable') {
      res.set('Content-Range', `bytes */${size}`);
      return res.status(416).end();
    }
    let downloadOptions;
    if (range) {
      res.status(206);
      res.set({ 'Content-Range': `bytes ${range.start}-${range.end}/${size}`, 'Content-Length': String(range.end - range.start + 1) });
      // GridFS "end" is exclusive.
      downloadOptions = { start: range.start, end: range.end + 1 };
    } else {
      res.set('Content-Length', String(size));
    }
    if (req?.method === 'HEAD') return res.end();
    bucket.openDownloadStream(file._id, downloadOptions).on('error', () => res.destroy()).pipe(res);
  }).catch(() => res.status(404).end());
}

/** Deletes a stored file from the cluster it lives on. Safe to call even if missing. */
async function deleteFile(clusterIndex, id) {
  if (!ObjectId.isValid(id)) return;
  try {
    await getBucket(clusterIndex).delete(new ObjectId(id));
  } catch (error) {
    // Already gone or cluster unreachable - nothing more we can do here.
  }
}

function mediaUrl({ cluster, id }) {
  return `/media/${cluster}/${id}`;
}

async function clusterStatus() {
  return Promise.all(connections.map(async (connection, index) => ({
    cluster: index,
    role: index === 0 ? 'primary' : 'extended',
    connected: connection.readyState === 1,
    host: connection.host || null
  })));
}

module.exports = {
  initStorageClusters,
  uploadBuffer,
  streamFile,
  parseRange,
  deleteFile,
  mediaUrl,
  clusterCount,
  clusterStatus,
  isReady
};
