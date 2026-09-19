const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRange } = require('../src/services/storageCluster');

test('no or malformed Range header means serve the whole file', () => {
  assert.equal(parseRange(undefined, 1000), null);
  assert.equal(parseRange('items=0-5', 1000), null);
  assert.equal(parseRange('bytes=-', 1000), null);
  assert.equal(parseRange('bytes=abc', 1000), null);
});

test('open-ended, bounded and suffix ranges are resolved against the file size', () => {
  assert.deepEqual(parseRange('bytes=0-', 1000), { start: 0, end: 999 });
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=900-5000', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-5000', 1000), { start: 0, end: 999 });
});

test('ranges outside the file are unsatisfiable (HTTP 416)', () => {
  assert.equal(parseRange('bytes=1000-', 1000), 'unsatisfiable');
  assert.equal(parseRange('bytes=500-100', 1000), 'unsatisfiable');
  assert.equal(parseRange('bytes=-0', 1000), 'unsatisfiable');
});

test('only the first range of a multi-range request is honoured', () => {
  assert.deepEqual(parseRange('bytes=0-9, 20-29', 1000), { start: 0, end: 9 });
});
