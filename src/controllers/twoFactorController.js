const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const User = require('../models/User');

function generateRecoveryCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i += 1) {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`);
  }
  return codes;
}

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
  const codes = generateRecoveryCodes();
  user.twoFactorEnabled = true;
  user.recoveryCodes = await Promise.all(codes.map(async (code) => ({ codeHash: await bcrypt.hash(code, 10) })));
  await user.save();
  // Recovery codes only ever exist in plaintext right here, right after
  // generation - shown once so the user can save/download them, then
  // discarded. Only the bcrypt hashes are persisted.
  req.session.freshRecoveryCodes = codes;
  res.redirect('/settings/security/2fa/recovery-codes');
};

exports.recoveryCodesPage = (req, res) => {
  const codes = req.session.freshRecoveryCodes;
  delete req.session.freshRecoveryCodes;
  if (!codes) return res.redirect('/settings/security');
  res.render('pages/recovery-codes', { title: 'Your recovery codes', pagePath: '/settings/security/2fa/recovery-codes', noIndex: true, codes });
};

exports.regenerateRecoveryCodes = async (req, res) => {
  const user = await User.findById(req.session.user.id);
  if (!user || !user.twoFactorEnabled || !(await bcrypt.compare(req.body.password || '', user.password))) {
    req.session.flash = { type: 'error', message: 'Enter your password to regenerate recovery codes.' };
    return res.redirect('/settings/security');
  }
  const codes = generateRecoveryCodes();
  user.recoveryCodes = await Promise.all(codes.map(async (code) => ({ codeHash: await bcrypt.hash(code, 10) })));
  await user.save();
  req.session.freshRecoveryCodes = codes;
  res.redirect('/settings/security/2fa/recovery-codes');
};

exports.disable = async (req, res) => {
  const user = await User.findById(req.session.user.id);
  if (!user || !(await bcrypt.compare(req.body.password || '', user.password))) {
    req.session.flash = { type: 'error', message: 'Enter your password to disable two-factor authentication.' };
    return res.redirect('/settings/security/2fa');
  }
  user.twoFactorEnabled = false;
  user.twoFactorSecret = undefined;
  user.recoveryCodes = [];
  await user.save();
  res.redirect('/settings/security');
};

exports.verifyLogin = async (req, res) => {
  const user = await User.findById(req.session.pendingTwoFactorUser);
  if (!user || !user.twoFactorSecret) {
    req.session.flash = { type: 'error', message: 'That authenticator code is not valid.' };
    return res.redirect('/auth/2fa');
  }

  let authenticated = false;
  if (req.body.recoveryCode) {
    const submitted = req.body.recoveryCode.trim().toUpperCase();
    for (const entry of user.recoveryCodes) {
      if (entry.usedAt) continue;
      if (await bcrypt.compare(submitted, entry.codeHash)) {
        entry.usedAt = new Date();
        authenticated = true;
        break;
      }
    }
    if (authenticated) await user.save();
  } else {
    authenticated = authenticator.verify({ token: req.body.code, secret: user.twoFactorSecret });
  }

  if (!authenticated) {
    req.session.flash = { type: 'error', message: req.body.recoveryCode ? 'That recovery code is not valid or was already used.' : 'That authenticator code is not valid.' };
    return res.redirect('/auth/2fa');
  }

  delete req.session.pendingTwoFactorUser;
  req.session.user = { id: user.id, name: user.name, email: user.email, isVerified: true, profilePicture: user.profilePicture || '' };
  const LoginSession = require('../models/LoginSession');
  await LoginSession.create({ user: user._id, sessionId: req.sessionID, ipAddress: req.ip, userAgent: req.get('user-agent') });
  if (req.body.recoveryCode) {
    const remaining = user.recoveryCodes.filter((entry) => !entry.usedAt).length;
    req.session.flash = { type: 'success', message: `Signed in with a recovery code. ${remaining} recovery code${remaining === 1 ? '' : 's'} left - regenerate them soon from Settings.` };
  }
  res.redirect('/dashboard');
};
