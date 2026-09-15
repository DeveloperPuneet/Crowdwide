const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const EventEmitter = require('events');
const { isConfigured, scanBuffer, scanRequestFiles } = require('../src/services/virusScan');

function fakeSocket() {
  const socket = new EventEmitter();
  socket.writes = [];
  socket.write = (data) => { socket.writes.push(data); return true; };
  socket.destroy = () => { socket.destroyed = true; };
  return socket;
}

// Simulates a clamd server: inspects what was written to the socket and
// asynchronously emits 'data'/'end' with a canned response.
function mockClamd(t, respond) {
  return t.mock.method(net, 'createConnection', () => {
    const socket = fakeSocket();
    process.nextTick(() => {
      socket.emit('connect');
      process.nextTick(() => respond(socket));
    });
    return socket;
  });
}

test('isConfigured is false with no CLAMAV_HOST/CLAMAV_SOCKET set', () => {
  delete process.env.CLAMAV_HOST;
  delete process.env.CLAMAV_SOCKET;
  assert.equal(isConfigured(), false);
});

test('isConfigured is true once CLAMAV_HOST is set', () => {
  process.env.CLAMAV_HOST = 'localhost';
  assert.equal(isConfigured(), true);
  delete process.env.CLAMAV_HOST;
});

test('scanBuffer sends the zINSTREAM command and completes cleanly against a well-behaved server', async (t) => {
  mockClamd(t, (socket) => {
    socket.emit('data', Buffer.from('stream: OK\0'));
    socket.emit('end');
  });
  const result = await scanBuffer(Buffer.from('hello world'));
  assert.deepEqual(result, { clean: true });
});

test('scanBuffer resolves clean:true for a clean-scan response', async (t) => {
  mockClamd(t, (socket) => {
    socket.emit('data', Buffer.from('stream: OK\0'));
    socket.emit('end');
  });
  const result = await scanBuffer(Buffer.from('just some ordinary file bytes'));
  assert.deepEqual(result, { clean: true });
});

test('scanBuffer resolves clean:false with a signature for an infected-scan response', async (t) => {
  mockClamd(t, (socket) => {
    socket.emit('data', Buffer.from('stream: Eicar-Test-Signature FOUND\0'));
    socket.emit('end');
  });
  const result = await scanBuffer(Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'));
  assert.deepEqual(result, { clean: false, signature: 'Eicar-Test-Signature' });
});

test('scanBuffer rejects on a malformed/unexpected response', async (t) => {
  mockClamd(t, (socket) => {
    socket.emit('data', Buffer.from('garbage response'));
    socket.emit('end');
  });
  await assert.rejects(scanBuffer(Buffer.from('data')), /Unexpected ClamAV response/);
});

test('scanBuffer rejects when the socket errors (e.g. connection refused)', async (t) => {
  t.mock.method(net, 'createConnection', () => {
    const socket = fakeSocket();
    process.nextTick(() => socket.emit('error', new Error('ECONNREFUSED')));
    return socket;
  });
  await assert.rejects(scanBuffer(Buffer.from('data')), /ECONNREFUSED/);
});

test('scanBuffer correctly frames a buffer larger than one chunk into multiple length-prefixed writes', async (t) => {
  const createConnectionCalls = mockClamd(t, (socket) => {
    socket.emit('data', Buffer.from('stream: OK\0'));
    socket.emit('end');
  });
  const bigBuffer = Buffer.alloc(64 * 1024 + 100, 'a');
  await scanBuffer(bigBuffer);
  const socket = createConnectionCalls.mock.calls[0].result;
  // command + (size header + chunk) * 2 chunks + zero-length terminator = 6 writes
  assert.equal(socket.writes[0].toString(), 'zINSTREAM\0');
  const firstSizeHeader = socket.writes[1];
  assert.equal(firstSizeHeader.readUInt32BE(0), 64 * 1024);
  assert.equal(socket.writes[2].length, 64 * 1024);
  const secondSizeHeader = socket.writes[3];
  assert.equal(secondSizeHeader.readUInt32BE(0), 100);
  assert.equal(socket.writes[4].length, 100);
  const terminator = socket.writes[5];
  assert.equal(terminator.length, 4);
  assert.equal(terminator.readUInt32BE(0), 0);
});

test('scanRequestFiles returns null without scanning anything when not configured', async (t) => {
  delete process.env.CLAMAV_HOST;
  delete process.env.CLAMAV_SOCKET;
  const createConnectionCalls = t.mock.method(net, 'createConnection');
  const result = await scanRequestFiles({ file: { buffer: Buffer.from('x'), originalname: 'x.png' } });
  assert.equal(result, null);
  assert.equal(createConnectionCalls.mock.callCount(), 0);
});

test('scanRequestFiles scans req.file (single-file route) and returns null when clean', async (t) => {
  process.env.CLAMAV_HOST = 'localhost';
  mockClamd(t, (socket) => {
    socket.emit('data', Buffer.from('stream: OK\0'));
    socket.emit('end');
  });
  const result = await scanRequestFiles({ file: { buffer: Buffer.from('clean file'), originalname: 'photo.png' } });
  assert.equal(result, null);
  delete process.env.CLAMAV_HOST;
});

test('scanRequestFiles returns the infected filename for req.files as an array (multi-file route)', async (t) => {
  process.env.CLAMAV_HOST = 'localhost';
  let call = 0;
  t.mock.method(net, 'createConnection', () => {
    const socket = fakeSocket();
    const response = call === 0 ? 'stream: OK\0' : 'stream: Eicar-Test-Signature FOUND\0';
    call += 1;
    process.nextTick(() => {
      socket.emit('connect');
      process.nextTick(() => {
        socket.emit('data', Buffer.from(response));
        socket.emit('end');
      });
    });
    return socket;
  });
  const result = await scanRequestFiles({
    files: [
      { buffer: Buffer.from('clean'), originalname: 'a.png' },
      { buffer: Buffer.from('infected'), originalname: 'b.png' }
    ]
  });
  assert.equal(result, 'b.png');
  delete process.env.CLAMAV_HOST;
});

test('scanRequestFiles returns the infected filename for req.files as a fields object (e.g. profile upload)', async (t) => {
  process.env.CLAMAV_HOST = 'localhost';
  mockClamd(t, (socket) => {
    socket.emit('data', Buffer.from('stream: Eicar-Test-Signature FOUND\0'));
    socket.emit('end');
  });
  const result = await scanRequestFiles({
    files: { profilePicture: [{ buffer: Buffer.from('infected'), originalname: 'avatar.jpg' }] }
  });
  assert.equal(result, 'avatar.jpg');
  delete process.env.CLAMAV_HOST;
});
