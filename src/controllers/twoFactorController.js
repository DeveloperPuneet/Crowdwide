const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const User = require('../models/User');

exports.setupPage = async (req, res) => {
  const user = await User.findById(req.session.user.id);
  if (!user.twoFactorSecret) {
    user.twoFactorSecret = authenticator.generateSecret();
    await user.save();
  }
  const otpauth = authenticator.keyuri(user.email, 'Crowdwide', user.twoFactorSecret);
  const qrCode = await QRCode.toDataURL(otpauth);
  res.render('pages/two-factor', { title: 'Two-factor authentication', pagePath: '/settings/security/2fa', noIndex: true, qrCode, enabled: user.twoFactorEnabled });
};

exports.enable = async (req, res) => {
  const user = await User.findById(req.session.user.id);
  if (!user.twoFactorSecret || !authenticator.verify({ token: req.body.code, secret: user.twoFactorSecret })) {
    req.session.flash = { type: 'error', message: 'That authenticator code is not valid.' };
    return res.redirect('/settings/security/2fa');
  }
  user.twoFactorEnabled = true;
  await user.save();
  req.session.flash = { type: 'success', message: 'Two-factor authentication is enabled.' };
  res.redirect('/settings/security');
};

exports.disable = async (req, res) => {
  const user = await User.findById(req.session.user.id);
  if (!user || !(await bcrypt.compare(req.body.password || '', user.password))) {
    req.session.flash = { type: 'error', message: 'Enter your password to disable two-factor authentication.' };
    return res.redirect('/settings/security/2fa');
  }
  user.twoFactorEnabled = false;
  user.twoFactorSecret = undefined;
  await user.save();
  res.redirect('/settings/security');
};

exports.verifyLogin = async (req, res) => {
  const user = await User.findById(req.session.pendingTwoFactorUser);
  if (!user || !user.twoFactorSecret || !authenticator.verify({ token: req.body.code, secret: user.twoFactorSecret })) {
    req.session.flash = { type: 'error', message: 'That authenticator code is not valid.' };
    return res.redirect('/auth/2fa');
  }
  delete req.session.pendingTwoFactorUser;
  req.session.user = { id: user.id, name: user.name, email: user.email, isVerified: true, profilePicture: user.profilePicture || '' };
  const LoginSession = require('../models/LoginSession');
  await LoginSession.create({ user: user._id, sessionId: req.sessionID, ipAddress: req.ip, userAgent: req.get('user-agent') });
  res.redirect('/dashboard');
};
