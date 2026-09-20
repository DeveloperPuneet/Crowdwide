const LoginSession = require('../models/LoginSession');
const User = require('../models/User');

function requireAuth(req, res, next) {
  if (!req.session.user) {
    // Group invite links: remember where the visitor was going so signing in
    // (or signing up) drops them back on the invite instead of the dashboard.
    if (req.method === 'GET' && /^\/groups\/join\/[A-Za-z0-9_-]+$/.test(req.path)) req.session.returnTo = req.path;
    req.session.flash = { type: 'error', message: 'Please sign in to continue.' };
    return res.redirect('/auth/login');
  }
  Promise.all([
    User.findById(req.session.user.id).select('inactivityLogoutDays'),
    LoginSession.findOne({ sessionId: req.sessionID, user: req.session.user.id })
  ]).then(([user, loginSession]) => {
    const timeoutDays = user?.inactivityLogoutDays || 0;
    const inactive = timeoutDays > 0 && loginSession && Date.now() - loginSession.lastSeenAt.getTime() > timeoutDays * 24 * 60 * 60 * 1000;
    if (inactive) {
      return LoginSession.deleteOne({ _id: loginSession._id }).then(() => req.session.destroy(() => res.redirect('/auth/login')));
    }
    if (!loginSession) return LoginSession.updateOne({ sessionId: req.sessionID }, { $set: { user: req.session.user.id, ipAddress: req.ip, userAgent: req.get('user-agent'), lastSeenAt: new Date() } }, { upsert: true }).then(() => next());
    // Only touch the database when lastSeenAt is meaningfully stale. Writing
    // it on every single request added a DB round trip to every page view and
    // every background poll (notifications, feed pagination).
    const stale = !loginSession.lastSeenAt || Date.now() - loginSession.lastSeenAt.getTime() > 5 * 60 * 1000;
    if (!stale) return next();
    return LoginSession.updateOne({ _id: loginSession._id }, { lastSeenAt: new Date() }).then(() => next());
  }).catch(next);
}

function requireVerified(req, res, next) {
  if (!req.session.user?.isVerified) {
    req.session.flash = { type: 'error', message: 'Verify your email before entering Crowdwide.' };
    return res.redirect(`/auth/verify?email=${encodeURIComponent(req.session.user.email)}`);
  }
  next();
}

module.exports = { requireAuth, requireVerified };
