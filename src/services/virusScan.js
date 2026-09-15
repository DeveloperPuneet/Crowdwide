// Scans an upload buffer against a ClamAV daemon (clamd) using its
// INSTREAM protocol - no external API key or paid service needed, just a
// clamd process reachable over TCP or a Unix socket. Graceful no-op when
// not configured, the same pattern as mailer/push/link-preview elsewhere
// in this app: a missing optional dependency degrades the feature, it
// never breaks the request.
//
// This environment could not install/run a real clamd to test against
// live (see todo.txt Known Gaps) - the protocol implementation below is
// unit-tested against a mocked socket instead. Try it against a real
// clamd (and the EICAR test file) before relying on it in production.

const net = require('net');
const logger = require('./logger');

const SCAN_TIMEOUT_MS = 10000;
const CHUNK_SIZE = 64 * 1024;

function isConfigured() {
  return Boolean(process.env.CLAMAV_HOST || process.env.CLAMAV_SOCKET);
}

function connect() {
  if (process.env.CLAMAV_SOCKET) return net.createConnection(process.env.CLAMAV_SOCKET);
  return net.createConnection({ host: process.env.CLAMAV_HOST, port: Number(process.env.CLAMAV_PORT || 3310) });
}

// Resolves { clean: boolean, signature?: string } for a configured scanner,
// or rejects if the scan itself could not be completed (timeout, connection
// refused, malformed response) - callers decide what "could not scan"
// should mean for the request (see uploads.js: this app fails open).
function scanBuffer(buffer) {
  return new Promise((resolve, reject) => {
    const socket = connect();
    const responseChunks = [];
    let settled = false;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };

    const timeout = setTimeout(() => finish(new Error('ClamAV scan timed out')), SCAN_TIMEOUT_MS);

    socket.on('error', (error) => finish(error));

    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      for (let offset = 0; offset < buffer.length; offset += CHUNK_SIZE) {
        const chunk = buffer.subarray(offset, offset + CHUNK_SIZE);
        const sizeHeader = Buffer.alloc(4);
        sizeHeader.writeUInt32BE(chunk.length, 0);
        socket.write(sizeHeader);
        socket.write(chunk);
      }
      socket.write(Buffer.alloc(4)); // zero-length chunk signals end of stream
    });

    socket.on('data', (data) => responseChunks.push(data));

    socket.on('end', () => {
      const response = Buffer.concat(responseChunks).toString('utf8').replace(/\0/g, '').trim();
      const foundMatch = response.match(/^stream:\s*(.+)\s+FOUND$/);
      if (foundMatch) return finish(null, { clean: false, signature: foundMatch[1] });
      if (/^stream:\s*OK$/.test(response)) return finish(null, { clean: true });
      finish(new Error(`Unexpected ClamAV response: ${response || '(empty)'}`));
    });
  });
}

// Scans every file on the request (multer puts them at req.file for a
// single-file route or req.files for multi-file/multi-field routes).
// Returns the name of the first infected file, or null if everything is
// clean or scanning isn't configured.
async function scanRequestFiles(req) {
  if (!isConfigured()) return null;
  const files = req.file
    ? [req.file]
    : Array.isArray(req.files)
      ? req.files
      : req.files
        ? Object.values(req.files).flat()
        : [];
  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop
    const result = await scanBuffer(file.buffer);
    if (!result.clean) {
      logger.warn('Upload blocked by virus scan', { filename: file.originalname, signature: result.signature });
      return file.originalname;
    }
  }
  return null;
}

module.exports = { isConfigured, scanBuffer, scanRequestFiles };
