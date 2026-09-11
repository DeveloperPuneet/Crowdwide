const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const LoginSession = require('../models/LoginSession');
const { sendVerificationCode } = require('../services/mailer');

const code = () => String(crypto.randomInt(100000, 1000000));
const token = () => crypto.randomBytes(24).toString('hex');
const setFlash = (req, type, message) => { req.session.flash = { type, message }; };

async function establishSession(req, user) {
  req.session.user = { id: user.id, name: user.name, email: user.email, isVerified: true, profilePicture: user.profilePicture || '' };
  await LoginSession.create({ user: user._id, sessionId: req.sessionID, ipAddress: req.ip, userAgent: req.get('user-agent') });
}

exports.loginPage = (req, res) => res.render('pages/login', { title: 'Sign in' });
exports.registerPage = (req, res) => res.render('pages/register', { title: 'Create your account' });
exports.verifyPage = (req, res) => res.render('pages/verify', { title: 'Verify your email', email: req.query.email || '' });
exports.forgotPage = (req, res) => res.render('pages/forgot-password', { title: 'Reset your password' });
exports.resetPage = (req, res) => res.render('pages/reset-password', { title: 'Choose a new password', token: req.query.token || '' });

exports.register = async (req, res) => {
  try {
    const { name, email, password } = req.body;
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
    if (!user || !(await bcrypt.compare(req.body.password || '', user.password))) {
      setFlash(req, 'error', 'That email and password combination is not recognized.');
      return res.redirect('/auth/login');
    }
    if (!user.isVerified) {
      const verificationCode = code();
      user.verificationCode = verificationCode;
      user.verificationExpires = Date.now() + 15 * 60 * 1000;
      await user.save();
      await sendVerificationCode(user, verificationCode);
      setFlash(req, 'error', 'Your email is not verified yet. We sent you a fresh code.');
      return res.redirect(`/auth/verify?email=${encodeURIComponent(user.email)}`);
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
  const user = await User.findOne({ email: req.body.email?.toLowerCase().trim() });
  if (user) {
    user.resetToken = token();
    user.resetExpires = Date.now() + 30 * 60 * 1000;
    await user.save();
    console.log(`[Crowdwide password reset preview] /auth/reset?token=${user.resetToken}`);
  }
  setFlash(req, 'success', 'If that email belongs to Crowdwide, a reset link is on its way.');
  res.redirect('/auth/forgot-password');
};

exports.reset = async (req, res) => {
  const user = await User.findOne({ resetToken: req.body.token, resetExpires: { $gt: Date.now() } });
  if (!user || !req.body.password || req.body.password.length < 8) {
    setFlash(req, 'error', 'That reset link is invalid or your password is too short.');
    return res.redirect(`/auth/reset?token=${encodeURIComponent(req.body.token || '')}`);
  }
  user.password = await bcrypt.hash(req.body.password, 12);
  user.resetToken = undefined;
  user.resetExpires = undefined;
  await user.save();
  setFlash(req, 'success', 'Your password has been updated.');
  res.redirect('/auth/login');
};

exports.logout = async (req, res) => {
  await LoginSession.deleteOne({ sessionId: req.sessionID });
  req.session.destroy(() => res.redirect('/'));
};
