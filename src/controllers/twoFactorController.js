const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { generateSecret, generateURI, verify } = require('otplib');
const QRCode = require('qrcode');
const User = require('../models/User');
const { sendSecurityAlert } = require('../services/mailer');
const { establishSession } = require('./authController');
const logger = require('../services/logger');
const { logEvent } = require('../services/accountHistory');

function generateRecoveryCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i += 1) {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`);
  }
  return codes;
}

exports.setupPage = async (req, res) => {
  try {
    const user = await User.findById(req.session.user.id);
    if (!user.twoFactorSecret) {
      user.twoFactorSecret = generateSecret();
      await user.save();
    }
    const otpauth = generateURI({ issuer: 'Crowdwide', label: user.email, secret: user.twoFactorSecret });
    const qrCode = await QRCode.toDataURL(otpauth);
    res.render('pages/two-factor', { title: 'Two-factor authentication', pagePath: '/settings/security/2fa', noIndex: true, qrCode, enabled: user.twoFactorEnabled });
  } catch (error) {
    logger.error('Two-factor authentication action failed', error);
    req.session.flash = { type: 'error', message: 'Could not load two-factor setup right now.' };
    res.redirect('/settings/security');
  }
};

exports.enable = async (req, res) => {
  try {
    const user = await User.findById(req.session.user.id);
    const verification = user.twoFactorSecret && await verify({ token: req.body.code, secret: user.twoFactorSecret, epochTolerance: 30 });
    if (!user.twoFactorSecret || !verification.valid) {
      req.session.flash = { type: 'error', message: 'That authenticator code is not valid.' };
      return res.redirect('/settings/security/2fa');
    }
    const codes = generateRecoveryCodes();
    user.twoFactorEnabled = true;
    user.recoveryCodes = await Promise.all(codes.map(async (code) => ({ codeHash: await bcrypt.hash(code, 10) })));
    await user.save();
    logEvent(user._id, 'two-factor-enabled');
    if (user.notificationPreferences?.security !== false) {
      await sendSecurityAlert(user, {
        subject: 'Two-factor authentication turned on',
        heading: 'Two-factor authentication enabled',
        message: 'Two-factor authentication was just turned on for your Crowdwide account. If you did not make this change, secure your account immediately.'
      });
    }
    // Recovery codes only ever exist in plaintext right here, right after
    // generation - shown once so the user can save/download them, then
    // discarded. Only the bcrypt hashes are persisted.
    req.session.freshRecoveryCodes = codes;
    res.redirect('/settings/security/2fa/recovery-codes');
  } catch (error) {
    logger.error('Two-factor authentication action failed', error);
    req.session.flash = { type: 'error', message: 'Could not enable two-factor authentication right now.' };
    res.redirect('/settings/security/2fa');
  }
};

exports.recoveryCodesPage = (req, res) => {
  const codes = req.session.freshRecoveryCodes;
  delete req.session.freshRecoveryCodes;
  if (!codes) return res.redirect('/settings/security');
  res.render('pages/recovery-codes', { title: 'Your recovery codes', pagePath: '/settings/security/2fa/recovery-codes', noIndex: true, codes });
};

exports.regenerateRecoveryCodes = async (req, res) => {
  try {
    const user = await User.findById(req.session.user.id);
    if (!user || !user.twoFactorEnabled || !(await bcrypt.compare(req.body.password || '', user.password))) {
      req.session.flash = { type: 'error', message: 'Enter your password to regenerate recovery codes.' };
      return res.redirect('/settings/security');
    }
    const codes = generateRecoveryCodes();
    user.recoveryCodes = await Promise.all(codes.map(async (code) => ({ codeHash: await bcrypt.hash(code, 10) })));
    await user.save();
    logEvent(user._id, 'recovery-codes-regenerated');
    if (user.notificationPreferences?.security !== false) {
      await sendSecurityAlert(user, {
        subject: 'Two-factor recovery codes regenerated',
        heading: 'Recovery codes regenerated',
        message: 'Your Crowdwide two-factor recovery codes were just regenerated. Your old recovery codes no longer work. If you did not make this change, secure your account immediately.'
      });
    }
    req.session.freshRecoveryCodes = codes;
    res.redirect('/settings/security/2fa/recovery-codes');
  } catch (error) {
    logger.error('Two-factor authentication action failed', error);
    req.session.flash = { type: 'error', message: 'Could not regenerate recovery codes right now.' };
    res.redirect('/settings/security');
  }
};

exports.disable = async (req, res) => {
  try {
    const user = await User.findById(req.session.user.id);
    if (!user || !(await bcrypt.compare(req.body.password || '', user.password))) {
      req.session.flash = { type: 'error', message: 'Enter your password to disable two-factor authentication.' };
      return res.redirect('/settings/security/2fa');
    }
    user.twoFactorEnabled = false;
    user.twoFactorSecret = undefined;
    user.recoveryCodes = [];
    await user.save();
    logEvent(user._id, 'two-factor-disabled');
    if (user.notificationPreferences?.security !== false) {
      await sendSecurityAlert(user, {
        subject: 'Two-factor authentication turned off',
        heading: 'Two-factor authentication disabled',
        message: 'Two-factor authentication was just turned off for your Crowdwide account. If you did not make this change, secure your account immediately.'
      });
    }
    res.redirect('/settings/security');
  } catch (error) {
    logger.error('Two-factor authentication action failed', error);
    req.session.flash = { type: 'error', message: 'Could not disable two-factor authentication right now.' };
    res.redirect('/settings/security/2fa');
  }
};

exports.verifyLogin = async (req, res) => {
  try {
    const user = await User.findById(req.session.pendingTwoFactorUser);
    if (!user || !user.twoFactorSecret || !req.session.pendingTwoFactorExpiresAt || req.session.pendingTwoFactorExpiresAt < Date.now()) {
      req.session.flash = { type: 'error', message: 'That authenticator code is not valid.' };
      return res.redirect('/auth/2fa');
    }
    if (user.twoFactorLockedUntil && user.twoFactorLockedUntil > Date.now()) {
      req.session.flash = { type: 'error', message: 'Too many 2FA attempts. Try again later.' };
      return res.redirect('/auth/login');
    }

    let authenticated = false;
    if (req.body.recoveryCode) {
      const submitted = req.body.recoveryCode.replace(/\s+/g, '').trim().toUpperCase();
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
      const verification = await verify({ token: req.body.code?.replace(/\s+/g, ''), secret: user.twoFactorSecret, epochTolerance: 30 });
      authenticated = verification.valid;
    }

    if (!authenticated) {
      user.twoFactorAttempts = (user.twoFactorAttempts || 0) + 1;
      if (user.twoFactorAttempts >= 3) {
        user.twoFactorLockedUntil = Date.now() + 15 * 60 * 1000;
        user.twoFactorAttempts = 0;
      }
      await user.save();
      req.session.flash = { type: 'error', message: req.body.recoveryCode ? 'That recovery code is not valid or was already used.' : 'That authenticator code is not valid.' };
      return res.redirect('/auth/2fa');
    }

    delete req.session.pendingTwoFactorUser;
    delete req.session.pendingTwoFactorExpiresAt;
    user.twoFactorAttempts = 0;
    user.twoFactorLockedUntil = undefined;
    await user.save();
    await establishSession(req, user);
    if (req.body.recoveryCode) {
      const remaining = user.recoveryCodes.filter((entry) => !entry.usedAt).length;
      req.session.flash = { type: 'success', message: `Signed in with a recovery code. ${remaining} recovery code${remaining === 1 ? '' : 's'} left - regenerate them soon from Settings.` };
    }
    res.redirect('/dashboard');
  } catch (error) {
    logger.error('Two-factor authentication action failed', error);
    req.session.flash = { type: 'error', message: 'Sign in is temporarily unavailable.' };
    res.redirect('/auth/login');
  }
};
