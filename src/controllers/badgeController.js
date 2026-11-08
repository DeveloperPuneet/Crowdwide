const User = require('../models/User');
const { BADGES, CATEGORIES, TIERS, badgeProgress } = require('../utils/badges');
const { collectFacts, evaluateBadges, forgetBadgeCheck } = require('../services/badgeSweep');
const { effectiveStreak, zoneOf } = require('../services/streaks');
const { TASK_BY_KEY } = require('../services/setup');
const logger = require('../services/logger');

// GET /badges - every badge, grouped, with the member's progress towards each one.
exports.badgesPage = async (req, res) => {
  forgetBadgeCheck(req.session.user.id);
  // Award anything newly earned first so the page is never a visit behind.
  const { facts } = await evaluateBadges(req.session.user.id).catch((error) => { logger.warn('Badge check failed', error); return { facts: null }; });
  const user = await User.findById(req.session.user.id).select('badges streak timezone').lean();
  const numbers = facts || (await collectFacts(req.session.user.id)) || {};
  const earnedAt = new Map((user?.badges || []).map((badge) => [badge.key, badge.earnedAt]));
  const sections = CATEGORIES.map((category) => ({
    ...category,
    badges: BADGES.filter((badge) => badge.category === category.id).map((badge) => ({
      ...badge,
      tierLabel: TIERS[badge.tier].label,
      earned: earnedAt.has(badge.key),
      earnedAt: earnedAt.get(badge.key) || null,
      progress: badgeProgress(badge, numbers)
    }))
  }));
  const earnedCount = BADGES.filter((badge) => earnedAt.has(badge.key)).length;
  // The three unearned badges that are closest to done.
  const nextUp = sections.flatMap((section) => section.badges)
    .filter((badge) => !badge.earned && badge.progress.value > 0 && badge.target > 1)
    .sort((a, b) => b.progress.pct - a.progress.pct)
    .slice(0, 3);
  const recent = [...earnedAt.entries()].sort((a, b) => new Date(b[1]) - new Date(a[1])).slice(0, 4).map(([key]) => BADGES.find((badge) => badge.key === key)).filter(Boolean);
  res.render('pages/badges', {
    title: 'Your badges',
    pagePath: '/badges',
    noIndex: true,
    sections,
    earnedCount,
    totalCount: BADGES.length,
    nextUp,
    recent,
    streakInfo: effectiveStreak(user?.streak, new Date(), zoneOf(user))
  });
};

// POST /setup/dismiss - hides one optional checklist item (required ones cannot be hidden).
exports.dismissSetup = async (req, res) => {
  const task = TASK_BY_KEY.get(String(req.body.key || ''));
  if (task && !task.required) await User.updateOne({ _id: req.session.user.id }, { $addToSet: { setupDismissed: task.key } });
  if (req.get('X-Requested-With') === 'XMLHttpRequest') return res.json({ ok: true });
  res.redirect(req.get('referer') ? new URL(req.get('referer'), 'http://x').pathname : '/dashboard');
};
