// Alt text, caption and transcript are entered per attached file. The composer
// posts repeated fields (mediaAlt, mediaAlt, ...) in file order, which the body
// parser turns into an array. A single string (older clients, API-style posts)
// applies to every file, which preserves the previous behaviour.
function pickForFile(value, index) {
  if (Array.isArray(value)) return String(value[index] ?? '').trim();
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function mediaDetailsFor(body = {}, index = 0) {
  return {
    alt: pickForFile(body.mediaAlt, index).slice(0, 280),
    caption: pickForFile(body.mediaCaption, index).slice(0, 280),
    transcript: pickForFile(body.mediaTranscript, index).slice(0, 4000)
  };
}

module.exports = { mediaDetailsFor, pickForFile };
