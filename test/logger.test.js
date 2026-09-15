const test = require('node:test');
const assert = require('node:assert/strict');
const logger = require('../src/services/logger');

function captureStream(stream) {
  const original = stream.write;
  const chunks = [];
  stream.write = (chunk) => { chunks.push(chunk); return true; };
  return { chunks, restore: () => { stream.write = original; } };
}

test('logger.info writes a single JSON line to stdout with level/message/time', () => {
  const capture = captureStream(process.stdout);
  logger.info('Server started');
  capture.restore();
  assert.equal(capture.chunks.length, 1);
  const parsed = JSON.parse(capture.chunks[0]);
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.message, 'Server started');
  assert.ok(parsed.time);
  assert.ok(!Number.isNaN(new Date(parsed.time).getTime()));
  assert.equal(parsed.meta, undefined);
});

test('logger.warn and logger.error write to stderr, not stdout', () => {
  const out = captureStream(process.stdout);
  const err = captureStream(process.stderr);
  logger.warn('careful');
  logger.error('broken');
  out.restore();
  err.restore();
  assert.equal(out.chunks.length, 0);
  assert.equal(err.chunks.length, 2);
  assert.equal(JSON.parse(err.chunks[0]).level, 'warn');
  assert.equal(JSON.parse(err.chunks[1]).level, 'error');
});

test('logger includes a meta object when provided', () => {
  const capture = captureStream(process.stderr);
  logger.error('upload failed', { userId: 'u1', fileSize: 4096 });
  capture.restore();
  const parsed = JSON.parse(capture.chunks[0]);
  assert.deepEqual(parsed.meta, { userId: 'u1', fileSize: 4096 });
});

test('logger normalizes a raw Error passed as meta into message + stack', () => {
  const capture = captureStream(process.stderr);
  logger.error('mail send failed', new Error('ECONNREFUSED'));
  capture.restore();
  const parsed = JSON.parse(capture.chunks[0]);
  assert.equal(parsed.meta.error, 'ECONNREFUSED');
  assert.ok(parsed.meta.stack.includes('ECONNREFUSED'));
});

test('logger normalizes an Error nested inside a meta object', () => {
  const capture = captureStream(process.stderr);
  logger.error('push failed', { userId: 'u1', error: new Error('410 Gone') });
  capture.restore();
  const parsed = JSON.parse(capture.chunks[0]);
  assert.equal(parsed.meta.userId, 'u1');
  assert.equal(parsed.meta.error, '410 Gone');
  assert.ok(parsed.meta.stack.includes('410 Gone'));
});

test('every log line is valid single-line JSON (safe for line-oriented log aggregators)', () => {
  const capture = captureStream(process.stdout);
  logger.info('multi\nline\nmessage embedded in text');
  capture.restore();
  assert.equal(capture.chunks.length, 1);
  assert.equal(capture.chunks[0].split('\n').filter(Boolean).length, 1);
  assert.doesNotThrow(() => JSON.parse(capture.chunks[0]));
});
