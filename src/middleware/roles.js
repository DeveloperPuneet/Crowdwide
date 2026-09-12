const User = require('../models/User');

async function loadRoleUser(req, res, next) {
  if (!req.session.user) return res.redirect('/auth/login');
  const user = await User.findById(req.session.user.id).select('name email role moderatorId isVerified').lean();
  if (!user) return res.redirect('/auth/login');
  req.roleUser = user;
  next();
}

function requireAdmin(req, res, next) {
  loadRoleUser(req, res, () => {
    if (req.roleUser.role !== 'admin') return res.status(403).render('pages/not-found', { title: 'Access denied' });
    next();
  });
}

function requireModerator(req, res, next) {
  loadRoleUser(req, res, () => {
    if (!['admin', 'moderator'].includes(req.roleUser.role)) return res.status(403).render('pages/not-found', { title: 'Access denied' });
    next();
  });
}

function requirePanelPassword(panel) {
  return (req, res, next) => {
    if (req.session.panelAccess?.[panel] > Date.now()) return next();
    res.redirect(`/${panel}/access?returnTo=/${panel}`);
  };
}

module.exports = { requireAdmin, requireModerator, requirePanelPassword };
