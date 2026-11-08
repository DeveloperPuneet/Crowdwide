// Badges members can earn. They are awarded automatically (services/streaks.js
// on every post/comment, services/badgeSweep.js for everything else) and each
// one is earned once.
//
// Every badge is plain data: a `metric` (a number we can measure about the
// member) and the `target` that earns it. That keeps the rules, the progress
// bars on /badges and the "what's next" hints all coming from one list.
const { iconInner } = require('./icons');

const TIERS = {
  bronze: { label: 'Bronze', pips: 1, colors: ['#f6c79c', '#cd7f32', '#8a4b1b'] },
  silver: { label: 'Silver', pips: 2, colors: ['#f4f7fb', '#aab4c8', '#6b768d'] },
  gold: { label: 'Gold', pips: 3, colors: ['#fff0a0', '#f2b01e', '#b87400'] },
  platinum: { label: 'Platinum', pips: 4, colors: ['#e0fbff', '#7ad7ee', '#5b6cf2'] },
  special: { label: 'Special', pips: 5, colors: ['#ffb3e1', '#a06bff', '#33c3ff'] }
};

const CATEGORIES = [
  { id: 'start', label: 'Getting started', blurb: 'Your first steps on Crowdwide.' },
  { id: 'posting', label: 'Posting', blurb: 'Share what you know and make.' },
  { id: 'conversation', label: 'Conversation', blurb: 'Join in and help discussions along.' },
  { id: 'streak', label: 'Streaks', blurb: 'Show up on consecutive days.' },
  { id: 'recognition', label: 'Recognition', blurb: 'Earned when other people respond to you.' },
  { id: 'community', label: 'Community', blurb: 'Connect with people and groups.' },
  { id: 'trust', label: 'Trust & milestones', blurb: 'Look after your account and stick around.' }
];

const b = (key, name, description, icon, tier, category, metric, target, shape = 'hex') => ({ key, name, description, icon, tier, category, metric, target, shape });

const BADGES = [
  // Getting started
  b('verified', 'Verified member', 'Confirmed your email address.', 'badge-check', 'bronze', 'start', 'verified', 1),
  b('onboarded', 'Welcome aboard', 'Finished the welcome tour.', 'rocket', 'bronze', 'start', 'onboarded', 1),
  b('profile-complete', 'Face of the crowd', 'Added a photo, a bio and at least 3 interests.', 'camera', 'bronze', 'start', 'profileComplete', 1),
  b('first-post', 'First post', 'Shared your first post.', 'edit', 'bronze', 'start', 'posts', 1),
  b('first-comment', 'First comment', 'Joined a conversation with your first comment.', 'message-square', 'bronze', 'start', 'comments', 1),
  b('first-reply', 'Conversation starter', 'Someone replied to your post for the first time.', 'message-circle', 'bronze', 'start', 'firstReply', 1),
  b('qotd', 'Question answerer', 'Answered the Question of the Day.', 'lightbulb', 'bronze', 'start', 'qotd', 1),

  // Posting
  b('posts-10', 'Regular', 'Published 10 posts.', 'file-text', 'silver', 'posting', 'posts', 10),
  b('posts-50', 'Storyteller', 'Published 50 posts.', 'award', 'gold', 'posting', 'posts', 50),
  b('posts-100', 'Prolific', 'Published 100 posts.', 'trophy', 'platinum', 'posting', 'posts', 100),
  b('article-1', 'Author', 'Published your first article.', 'file-text', 'bronze', 'posting', 'articles', 1),
  b('articles-5', 'Columnist', 'Published 5 articles.', 'layers', 'silver', 'posting', 'articles', 5),
  b('poll-1', 'Pollster', 'Asked the crowd with your first poll.', 'bar-chart', 'bronze', 'posting', 'polls', 1),

  // Conversation
  b('comments-25', 'Conversationalist', 'Left 25 comments.', 'users', 'silver', 'conversation', 'comments', 25),
  b('comments-100', 'Discussion regular', 'Left 100 comments.', 'message-square', 'gold', 'conversation', 'comments', 100),
  b('comments-500', 'Voice of the crowd', 'Left 500 comments.', 'megaphone', 'platinum', 'conversation', 'comments', 500),
  b('heart-1', 'Creator’s heart', 'An author gave one of your comments a heart.', 'heart', 'bronze', 'conversation', 'hearts', 1),
  b('hearts-10', 'Crowd favourite', 'Authors hearted 10 of your comments.', 'heart', 'silver', 'conversation', 'hearts', 10),

  // Streaks
  b('streak-3', '3-day streak', 'Posted or commented 3 days in a row.', 'flame', 'bronze', 'streak', 'streak', 3, 'circle'),
  b('streak-7', '7-day streak', 'Posted or commented 7 days in a row.', 'flame', 'silver', 'streak', 'streak', 7, 'circle'),
  b('streak-14', '14-day streak', 'Posted or commented 14 days in a row.', 'flame', 'silver', 'streak', 'streak', 14, 'circle'),
  b('streak-30', '30-day streak', 'Posted or commented 30 days in a row.', 'flame', 'gold', 'streak', 'streak', 30, 'circle'),
  b('streak-100', '100-day streak', 'Posted or commented 100 days in a row.', 'flame', 'platinum', 'streak', 'streak', 100, 'circle'),
  b('streak-365', 'Year-long streak', 'Posted or commented every day for a year.', 'crown', 'special', 'streak', 'streak', 365, 'circle'),

  // Recognition
  b('likes-10', 'Noticed', 'Your posts earned 10 likes.', 'thumbs-up', 'bronze', 'recognition', 'likes', 10),
  b('likes-100', 'Well liked', 'Your posts earned 100 likes.', 'thumbs-up', 'silver', 'recognition', 'likes', 100),
  b('likes-500', 'Crowd pleaser', 'Your posts earned 500 likes.', 'star', 'gold', 'recognition', 'likes', 500),
  b('likes-2000', 'Fan favourite', 'Your posts earned 2,000 likes.', 'sparkles', 'platinum', 'recognition', 'likes', 2000),

  // Community
  b('followers-10', 'Rising voice', '10 people follow you.', 'user-plus', 'bronze', 'community', 'followers', 10),
  b('followers-50', 'Familiar face', '50 people follow you.', 'user-plus', 'silver', 'community', 'followers', 50),
  b('followers-250', 'Community voice', '250 people follow you.', 'users', 'gold', 'community', 'followers', 250),
  b('followers-1000', 'Influencer', '1,000 people follow you.', 'crown', 'platinum', 'community', 'followers', 1000),
  b('following-10', 'Connector', 'Follow 10 people.', 'users', 'bronze', 'community', 'following', 10),
  b('community-1', 'Joiner', 'Joined your first community.', 'globe', 'bronze', 'community', 'communities', 1),
  b('community-5', 'Explorer', 'Joined 5 communities.', 'compass', 'silver', 'community', 'communities', 5),
  b('founder', 'Founder', 'Started your own community.', 'flag', 'gold', 'community', 'founded', 1),

  // Trust & milestones
  b('two-factor', 'Locked in', 'Turned on two-factor authentication.', 'shield-check', 'silver', 'trust', 'twoFactor', 1, 'shield'),
  b('early-member', 'Founding member', 'One of the first members of Crowdwide.', 'sparkles', 'special', 'trust', 'early', 1, 'rosette'),
  b('veteran-30', 'One month in', 'A member for 30 days.', 'clock', 'silver', 'trust', 'accountDays', 30),
  b('veteran-365', 'One year in', 'A member for a whole year.', 'trophy', 'gold', 'trust', 'accountDays', 365)
];

const BY_KEY = new Map(BADGES.map((badge) => [badge.key, badge]));
const badgeInfo = (key) => BY_KEY.get(key) || null;

// Badges a member qualifies for given their numbers (pure, so it is easy to test).
// Only the numbers that are provided are checked, so a caller that knows just
// a couple of them (a new post, a new comment) never awards anything else.
// `streak`, `posts`, `comments` and `answeredQotd` are the original names.
function badgesFor(facts = {}) {
  const numbers = { ...facts };
  if (facts.answeredQotd !== undefined) numbers.qotd = facts.answeredQotd ? 1 : 0;
  return BADGES.filter((badge) => {
    const value = numbers[badge.metric];
    return value !== null && value !== undefined && Number(value) >= badge.target;
  }).map((badge) => badge.key);
}

// How far along a badge is: { value, target, pct, done }.
function badgeProgress(badge, facts = {}) {
  const raw = Number(facts[badge.metric] || 0);
  const value = Math.max(0, Math.min(raw, badge.target));
  return { value, target: badge.target, pct: Math.round((value / badge.target) * 100), done: raw >= badge.target };
}

// The not-yet-earned badge in each category that is closest to being earned.
function nextBadges(facts = {}, ownedKeys = [], limit = 3) {
  const owned = new Set(ownedKeys);
  return BADGES.filter((badge) => !owned.has(badge.key))
    .map((badge) => ({ badge, ...badgeProgress(badge, facts) }))
    .filter((entry) => entry.value > 0 && entry.target > 1)
    .sort((a, c) => c.pct - a.pct)
    .slice(0, limit);
}

const compact = (n) => (n >= 1000 ? `${Math.round((n / 1000) * 10) / 10}K`.replace('.0K', 'K') : String(n));

// ------------------------------------------------------------------- medal art
// Each badge is drawn as a small SVG medal: a tier-coloured rim (bronze, silver,
// gold, platinum, or a prismatic "special"), a dark face with the badge's icon,
// and either a number plate (streak days, post counts...) or tier pips.
let medalSerial = 0;

function outline(shape) {
  if (shape === 'circle') return { d: 'M48 4a44 44 0 1 1 0 88a44 44 0 1 1 0-88z', inner: 'M48 11a37 37 0 1 1 0 74a37 37 0 1 1 0-74z' };
  if (shape === 'shield') return { d: 'M48 4 L86 17 V47 C86 70 69 85 48 93 C27 85 10 70 10 47 V17 Z', inner: 'M48 11 L79 21.5 V47 C79 66 65 78 48 85.5 C31 78 17 66 17 47 V21.5 Z' };
  if (shape === 'rosette') {
    const points = (outer, inner) => Array.from({ length: 24 }, (_, i) => {
      const radius = i % 2 ? inner : outer;
      const angle = (Math.PI * 2 * i) / 24 - Math.PI / 2;
      return `${(48 + radius * Math.cos(angle)).toFixed(1)},${(48 + radius * Math.sin(angle)).toFixed(1)}`;
    }).join(' ');
    return { points: points(45, 39), innerPoints: points(37, 33) };
  }
  // hexagon, point up
  const hex = (radius) => Array.from({ length: 6 }, (_, i) => {
    const angle = (Math.PI / 3) * i - Math.PI / 2;
    return `${(48 + radius * Math.cos(angle)).toFixed(1)},${(48 + radius * Math.sin(angle)).toFixed(1)}`;
  }).join(' ');
  return { points: hex(45), innerPoints: hex(38) };
}

// Returns an inline <svg> string. `locked` greys it out (badges not yet earned).
function badgeMedal(badgeOrKey, { size = 64, locked = false, label = true } = {}) {
  const badge = typeof badgeOrKey === 'string' ? badgeInfo(badgeOrKey) : badgeOrKey;
  if (!badge) return '';
  const tier = TIERS[badge.tier] || TIERS.bronze;
  const [light, mid, dark] = tier.colors;
  const id = `cwm${medalSerial = (medalSerial + 1) % 1e6}`;
  const shape = outline(badge.shape);
  const draw = (attrs, inner = false) => (shape.d
    ? `<path d="${inner ? shape.inner : shape.d}" ${attrs}/>`
    : `<polygon points="${inner ? shape.innerPoints : shape.points}" stroke-linejoin="round" ${attrs}/>`);
  const plate = badge.target > 1 ? compact(badge.target) : '';
  const bottom = plate && label
    ? `<g><rect x="${48 - (plate.length * 4.6 + 9)}" y="68" width="${plate.length * 9.2 + 18}" height="17" rx="8.5" fill="#12142a" stroke="url(#${id}r)" stroke-width="1.6"/><text x="48" y="80.4" text-anchor="middle" font-family="DM Sans, system-ui, sans-serif" font-size="11" font-weight="800" fill="${light}">${plate}</text></g>`
    : Array.from({ length: tier.pips }, (_, i) => {
      const x = 48 + (i - (tier.pips - 1) / 2) * 9;
      return `<circle cx="${x}" cy="77" r="2.6" fill="${light}"/>`;
    }).join('');
  const glyph = iconInner(badge.icon);
  const accessible = `${badge.name} badge, ${tier.label.toLowerCase()}${locked ? ', not earned yet' : ''}`;
  return `<svg class="badge-medal badge-tier-${badge.tier}${locked ? ' is-locked' : ''}" width="${size}" height="${size}" viewBox="0 0 96 96" role="img" aria-label="${accessible}">`
    + `<defs><linearGradient id="${id}r" x1="14" y1="6" x2="82" y2="92" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${light}"/><stop offset=".5" stop-color="${mid}"/><stop offset="1" stop-color="${dark}"/></linearGradient>`
    + `<radialGradient id="${id}f" cx="40%" cy="30%" r="80%"><stop offset="0" stop-color="#2d3260"/><stop offset="1" stop-color="#14162e"/></radialGradient></defs>`
    + draw(`fill="url(#${id}r)"`)
    + draw(`fill="url(#${id}f)" stroke="${dark}" stroke-width="1.2"`, true)
    + `<g transform="translate(31 22) scale(1.42)" fill="none" stroke="${light}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${glyph}</g>`
    + bottom
    + '</svg>';
}

module.exports = { BADGES, TIERS, CATEGORIES, badgeInfo, badgesFor, badgeProgress, nextBadges, badgeMedal };
