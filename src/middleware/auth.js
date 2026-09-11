function requireAuth(req, res, next) {
  if (!req.session.user) {
    req.session.flash = { type: 'error', message: 'Please sign in to continue.' };
    return res.redirect('/auth/login');
  }
  next();
}

function requireVerified(req, res, next) {
  if (!req.session.user?.isVerified) {
    req.session.flash = { type: 'error', message: 'Verify your email before entering Crowdwide.' };
    return res.redirect(`/auth/verify?email=${encodeURIComponent(req.session.user.email)}`);
  }
  next();
}

module.exports = { requireAuth, requireVerified };
