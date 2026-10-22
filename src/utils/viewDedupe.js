// A post or profile view counts once per viewer per window, however often the page is
// reloaded and whatever ?query string is tacked on (the counter keys on the post/profile
// id, never on the URL). Viewer = the signed-in account, otherwise the address.
const WINDOW_MS = 30 * 60 * 1000;
const MAX = 100000;
const seen = new Map();

function shouldCount(kind, targetId, req, now = Date.now()) {
  const viewer = req.session?.user?.id ? `u${req.session.user.id}` : `i${req.ip || 'unknown'}`;
  const key = `${kind}:${targetId}:${viewer}`;
  const last = seen.get(key);
  if (last && now - last < WINDOW_MS) return false;
  if (seen.size >= MAX) {
    for (const [k, t] of seen) { if (now - t >= WINDOW_MS) seen.delete(k); if (seen.size < MAX * 0.8) break; }
    if (seen.size >= MAX) seen.delete(seen.keys().next().value);
  }
  seen.set(key, now);
  return true;
}
const reset = () => seen.clear();
module.exports = { shouldCount, reset, WINDOW_MS };
