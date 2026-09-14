const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

// Returns true if this user already has a non-draft post with the exact
// same body text within the last `windowMs` - the classic "spam bot posts
// the same thing over and over" pattern. This is a narrow, high-confidence
// signal (exact match only) chosen to avoid false positives on legitimate
// short repeated phrases ("lol", "this") that a broader similarity check
// would incorrectly flag.
async function isRepeatPost(Post, userId, body, windowMs = DUPLICATE_WINDOW_MS) {
  if (!body) return false;
  const recent = await Post.findOne({
    author: userId,
    body,
    status: { $ne: 'draft' },
    createdAt: { $gt: new Date(Date.now() - windowMs) }
  }).select('_id').lean();
  return Boolean(recent);
}

module.exports = { isRepeatPost, DUPLICATE_WINDOW_MS };
