const test = require('node:test');
const assert = require('node:assert/strict');
const { mediaDetailsFor } = require('../src/utils/mediaDetails');

test('repeated fields map to each file by position', () => {
  const body = { mediaAlt: ['A cat', 'A dog'], mediaCaption: ['First', ''], mediaTranscript: ['', 'Second transcript'] };
  assert.deepEqual(mediaDetailsFor(body, 0), { alt: 'A cat', caption: 'First', transcript: '' });
  assert.deepEqual(mediaDetailsFor(body, 1), { alt: 'A dog', caption: '', transcript: 'Second transcript' });
});

test('a single string applies to every file (backwards compatible)', () => {
  const body = { mediaAlt: ' Shared alt ' };
  assert.equal(mediaDetailsFor(body, 0).alt, 'Shared alt');
  assert.equal(mediaDetailsFor(body, 1).alt, 'Shared alt');
});

test('missing fields and out-of-range indexes give empty strings, and lengths are capped', () => {
  assert.deepEqual(mediaDetailsFor({}, 0), { alt: '', caption: '', transcript: '' });
  assert.deepEqual(mediaDetailsFor({ mediaAlt: ['only one'] }, 3), { alt: '', caption: '', transcript: '' });
  assert.equal(mediaDetailsFor({ mediaAlt: ['x'.repeat(500)], mediaTranscript: ['y'.repeat(9000)] }, 0).alt.length, 280);
  assert.equal(mediaDetailsFor({ mediaTranscript: ['y'.repeat(9000)] }, 0).transcript.length, 4000);
});
