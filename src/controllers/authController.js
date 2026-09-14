const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const LoginSession = require('../models/LoginSession');
const { sendVerificationCode, sendNewDeviceAlert, sendPasswordResetLink, sendSecurityAlert } = require('../services/mailer');
const { generateChallenge, verifyChallenge } = require('../services/captcha');

const code = () => String(crypto.randomInt(100000, 1000000));
const token = () => crypto.randomBytes(24).toString('hex');
const setFlash = (req, type, message) => { req.session.flash = { type, message }; };

async function establishSession(req, user) {
  req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role || 'user', moderatorId: user.moderatorId || '', isVerified: true, profilePicture: user.profilePicture || '' };
  const existingSession = await LoginSession.exists({ user: user._id });
  await LoginSession.create({ user: user._id, sessionId: req.sessionID, ipAddress: req.ip, userAgent: req.get('user-agent') });
  if (existingSession && user.notificationPreferences?.security !== false) {
    await sendNewDeviceAlert(user, { ipAddress: req.ip, userAgent: req.get('user-agent') });
  }
}

exports.establishSession = establishSession;

exports.loginPage = (req, res) => res.render('pages/login', { title: 'Sign in' });
exports.registerPage = (req, res) => res.render('pages/register', { title: 'Create your account', captcha: generateChallenge(req) });
exports.verifyPage = (req, res) => res.render('pages/verify', { title: 'Verify your email', email: req.query.email || '' });
exports.forgotPage = (req, res) => res.render('pages/forgot-password', { title: 'Reset your password' });
exports.resetPage = (req, res) => res.render('pages/reset-password', { title: 'Choose a new password', token: req.query.token || '' });

exports.register = async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!verifyChallenge(req, req.body.captchaAnswer)) {
      setFlash(req, 'error', 'That verification answer was not correct. Try again.');
      return res.redirect('/auth/register');
    }
    if (!name || !email || !password || password.length < 8) {
      setFlash(req, 'error', 'Add your name, a valid email, and a password of at least 8 characters.');
      return res.redirect('/auth/register');
    }
    const normalizedEmail = email.toLowerCase().trim();
    let user = await User.findOne({ email: normalizedEmail });
    if (user?.isVerified) {
      setFlash(req, 'error', 'An account with that email already exists.');
      return res.redirect('/auth/login');
    }
    const verificationCode = code();
    if (!user) user = new User({ name, email: normalizedEmail, password: await bcrypt.hash(password, 12) });
    user.verificationCode = verificationCode;
    user.verificationExpires = Date.now() + 15 * 60 * 1000;
    await user.save();
    await sendVerificationCode(user, verificationCode);
    setFlash(req, 'success', 'Your verification code is on its way.');
    res.redirect(`/auth/verify?email=${encodeURIComponent(user.email)}`);
  } catch (error) {
    console.error(error);
    setFlash(req, 'error', 'We could not create your account right now.');
    res.redirect('/auth/register');
  }
};

exports.login = async (req, res) => {
  try {
    const user = await User.findOne({ email: req.body.email?.toLowerCase().trim() });
    if (user?.suspendedUntil && user.suspendedUntil > Date.now()) {
      setFlash(req, 'error', `Your account is suspended until ${new Date(user.suspendedUntil).toLocaleString()}.${user.suspensionReason ? ` Reason: ${user.suspensionReason}` : ''}`);
      return res.redirect('/auth/login');
    }
    if (user?.loginLockedUntil && user.loginLockedUntil > Date.now()) {
      setFlash(req, 'error', 'Too many failed attempts. Try again later.');
      return res.redirect('/auth/login');
    }
    if (!user || !(await bcrypt.compare(req.body.password || '', user.password))) {
      if (user) {
        user.loginAttempts = (user.loginAttempts || 0) + 1;
        if (user.loginAttempts >= 5) {
          user.loginLockedUntil = Date.now() + 15 * 60 * 1000;
          user.loginAttempts = 0;
        }
        await user.save();
      }
      setFlash(req, 'error', 'That email and password combination is not recognized.');
      return res.redirect('/auth/login');
    }
    if (process.env.ADMIN_EMAIL && user.email === process.env.ADMIN_EMAIL.toLowerCase().trim() && user.role !== 'admin') user.role = 'admin';
    user.loginAttempts = 0;
    user.loginLockedUntil = undefined;
    await user.save();
    if (!user.isVerified) {
      const verificationCode = code();
      user.verificationCode = verificationCode;
      user.verificationExpires = Date.now() + 15 * 60 * 1000;
      await user.save();
      await sendVerificationCode(user, verificationCode);
      setFlash(req, 'error', 'Your email is not verified yet. We sent you a fresh code.');
      return res.redirect(`/auth/verify?email=${encodeURIComponent(user.email)}`);
    }
    if (user.twoFactorEnabled) {
      req.session.pendingTwoFactorUser = user.id;
      req.session.pendingTwoFactorExpiresAt = Date.now() + 10 * 60 * 1000;
      return res.redirect('/auth/2fa');
    }
    await establishSession(req, user);
    res.redirect('/dashboard');
  } catch (error) {
    setFlash(req, 'error', 'Sign in is temporarily unavailable.');
    res.redirect('/auth/login');
  }
};

exports.verify = async (req, res) => {
  try {
    const user = await User.findOne({ email: req.body.email?.toLowerCase().trim() });
    if (!user || user.verificationCode !== req.body.code || !user.verificationExpires || user.verificationExpires < Date.now()) {
      setFlash(req, 'error', 'That code is invalid or has expired.');
      return res.redirect(`/auth/verify?email=${encodeURIComponent(req.body.email || '')}`);
    }
    user.isVerified = true;
    user.verificationCode = undefined;
    user.verificationExpires = undefined;
    await user.save();
    await establishSession(req, user);
    res.redirect('/dashboard');
  } catch (error) {
    setFlash(req, 'error', 'We could not verify that code right now.');
    res.redirect('/auth/verify');
  }
};

exports.forgot = async (req, res) => {
  try {
    const user = await User.findOne({ email: req.body.email?.toLowerCase().trim() });
    if (user) {
      user.resetToken = token();
      user.resetExpires = Date.now() + 30 * 60 * 1000;
      await user.save();
      const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
      await sendPasswordResetLink(user, `${appUrl}/auth/reset?token=${user.resetToken}`);
    }
    setFlash(req, 'success', 'If that email belongs to Crowdwide, a reset link is on its way.');
    res.redirect('/auth/forgot-password');
  } catch (error) {
    console.error(error);
    setFlash(req, 'error', 'We could not process that request right now.');
    res.redirect('/auth/forgot-password');
  }
};

exports.reset = async (req, res) => {
  try {
    const user = await User.findOne({ resetToken: req.body.token, resetExpires: { $gt: Date.now() } });
    if (!user || !req.body.password || req.body.password.length < 8) {
      setFlash(req, 'error', 'That reset link is invalid or your password is too short.');
      return res.redirect(`/auth/reset?token=${encodeURIComponent(req.body.token || '')}`);
    }
    user.password = await bcrypt.hash(req.body.password, 12);
    user.resetToken = undefined;
    user.resetExpires = undefined;
    await user.save();
    if (user.notificationPreferences?.security !== false) {
      await sendSecurityAlert(user, {
        subject: 'Your Crowdwide password was reset',
        heading: 'Password reset',
        message: 'Your Crowdwide password was just reset. If you did not do this, secure your account immediately by resetting your password again and reviewing your active sessions.'
      });
    }
    setFlash(req, 'success', 'Your password has been updated.');
    res.redirect('/auth/login');
  } catch (error) {
    console.error(error);
    setFlash(req, 'error', 'We could not reset your password right now.');
    res.redirect(`/auth/reset?token=${encodeURIComponent(req.body.token || '')}`);
  }
};

exports.logout = async (req, res) => {
  await LoginSession.deleteOne({ sessionId: req.sessionID });
  req.session.destroy(() => res.redirect('/'));
};
