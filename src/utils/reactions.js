// Shared emoji-reaction logic for comments, direct messages and group
// messages. Stored as an array of { emoji, users: [ObjectId] } subdocuments
// on the owning document; a user can react with more than one emoji (like
// Slack), toggling each independently.
const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '🎉'];

// Applies the toggle to a plain-object reactions array (already converted
// from Mongoose subdocuments with .map(r => r.toObject ? r.toObject() : r))
// and returns the new array plus a lightweight summary for the JSON reply.
function toggleReaction(reactions, emoji, userId) {
  if (!REACTION_EMOJIS.includes(emoji)) return null;
  const list = (reactions || []).map((entry) => ({ emoji: entry.emoji, users: (entry.users || []).map(String) }));
  let entry = list.find((row) => row.emoji === emoji);
  if (!entry) { entry = { emoji, users: [] }; list.push(entry); }
  const uid = String(userId);
  const reacted = entry.users.includes(uid);
  entry.users = reacted ? entry.users.filter((id) => id !== uid) : [...entry.users, uid];
  const cleaned = list.filter((row) => row.users.length > 0);
  return { reactions: cleaned, reacted: !reacted, summary: summarize(cleaned, uid) };
}

function summarize(reactions, userId) {
  const uid = String(userId);
  return (reactions || [])
    .filter((entry) => (entry.users || []).length > 0)
    .map((entry) => ({ emoji: entry.emoji, count: entry.users.length, reacted: entry.users.map(String).includes(uid) }));
}

module.exports = { REACTION_EMOJIS, toggleReaction, summarize };
