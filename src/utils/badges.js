// Badges members can earn. Awarded automatically (see services/streaks.js);
// each is earned once and shown on the member's profile.
const BADGES = [
  { key: 'first-post', name: 'First post', description: 'Shared your first post.', icon: 'edit' },
  { key: 'first-comment', name: 'First comment', description: 'Joined a conversation with your first comment.', icon: 'message-square' },
  { key: 'first-reply', name: 'Conversation starter', description: 'Someone replied to your post for the first time.', icon: 'message-circle' },
  { key: 'qotd', name: 'Question answerer', description: 'Answered the Question of the Day.', icon: 'lightbulb' },
  { key: 'streak-3', name: '3-day streak', description: 'Posted or commented 3 days in a row.', icon: 'flame' },
  { key: 'streak-7', name: '7-day streak', description: 'Posted or commented 7 days in a row.', icon: 'flame' },
  { key: 'streak-30', name: '30-day streak', description: 'Posted or commented 30 days in a row.', icon: 'flame' },
  { key: 'posts-10', name: 'Regular', description: 'Published 10 posts.', icon: 'file-text' },
  { key: 'posts-50', name: 'Storyteller', description: 'Published 50 posts.', icon: 'award' },
  { key: 'comments-25', name: 'Conversationalist', description: 'Left 25 comments.', icon: 'users' }
];

const BY_KEY = new Map(BADGES.map((badge) => [badge.key, badge]));
const STREAK_BADGES = [[3, 'streak-3'], [7, 'streak-7'], [30, 'streak-30']];
const POST_BADGES = [[1, 'first-post'], [10, 'posts-10'], [50, 'posts-50']];
const COMMENT_BADGES = [[1, 'first-comment'], [25, 'comments-25']];

const badgeInfo = (key) => BY_KEY.get(key) || null;

// Badges a member qualifies for given their numbers (pure, so it is easy to test).
function badgesFor({ streak = 0, posts = null, comments = null, answeredQotd = false } = {}) {
  const keys = [];
  STREAK_BADGES.forEach(([needed, key]) => { if (streak >= needed) keys.push(key); });
  if (posts !== null) POST_BADGES.forEach(([needed, key]) => { if (posts >= needed) keys.push(key); });
  if (comments !== null) COMMENT_BADGES.forEach(([needed, key]) => { if (comments >= needed) keys.push(key); });
  if (answeredQotd) keys.push('qotd');
  return keys;
}

module.exports = { BADGES, badgeInfo, badgesFor };
