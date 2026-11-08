const { grantWelcomeBonus } = require('../services/waves');
const { generateUniqueUsername } = require('../services/username');
const crypto = require('crypto');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const LoginSession = require('../models/LoginSession');
const { sendVerificationCode, sendNewDeviceAlert, sendPasswordResetLink, sendSecurityAlert } = require('../services/mailer');
const { generateChallenge, verifyChallenge, looksAutomated, verifyTurnstile, turnstileEnabled, turnstileSiteKey } = require('../services/captcha');
const logger = require('../services/logger');
const { enabledProviders } = require('../services/oauth');
const { logEvent } = require('../services/accountHistory');
const { hashPassword } = require('../utils/passwords');
const { recordActivity } = require('../services/reengagement');
const { passwordProblem } = require('../utils/passwordPolicy');
const { revokeSessions } = require('../services/sessions');
const { sha256, linkMatches } = require('../services/unverified');
const { evaluateBadges } = require('../services/badgeSweep');

// Compared against when an email is unknown, so "no such account" takes as long as "wrong password".
const DUMMY_HASH = bcrypt.hashSync('crowdwide-timing-equaliser', 10);
const MAX_VERIFY_ATTEMPTS = 5;
const asText = (value, max = 320) => (typeof value === 'string' ? value.slice(0, max) : '');
const sameText = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

const code = () => String(crypto.randomInt(100000, 1000000));
const token = () => crypto.randomBytes(24).toString('hex');
const setFlash = (req, type, message) => { req.session.flash = { type, message }; };

// A fresh session id at every sign-in, so an id planted before login (session
// fixation) is worthless afterwards. Only the "where to go next" link survives.
async function regenerateSession(req) {
  if (typeof req.session?.regenerate !== 'function') return;
  const returnTo = req.session.returnTo;
  const previousId = req.sessionID;
  await new Promise((resolve, reject) => req.session.regenerate((error) => (error ? reject(error) : resolve())));
  if (returnTo) req.session.returnTo = returnTo;
  await LoginSession.deleteOne({ sessionId: previousId }).catch(() => {});
}

async function establishSession(req, user) {
  await regenerateSession(req);
  req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role || 'user', moderatorId: user.moderatorId || '', isVerified: true, profilePicture: user.profilePicture || '', theme: user.theme || 'default' };
  const existingSession = await LoginSession.exists({ user: user._id });
  // Upsert rather than create: signing in again from a browser that already
  // has a LoginSession for this session id used to hit the unique index and
  // fail the whole sign-in with "temporarily unavailable".
  await LoginSession.findOneAndUpdate(
    { sessionId: req.sessionID },
    { user: user._id, sessionId: req.sessionID, ipAddress: req.ip, userAgent: req.get('user-agent'), lastSeenAt: new Date() },
    { upsert: true, setDefaultsOnInsert: true }
  );
  logEvent(user._id, 'login', req.ip);
  // Remembers when they were last here (and notes a long absence for the welcome-back card).
  await recordActivity(user._id, req.session).catch((error) => logger.warn('Could not record sign-in activity', error));
  if (existingSession && user.notificationPreferences?.security !== false) {
    // Not awaited: the email is a courtesy and must never slow sign-in down.
    sendNewDeviceAlert(user, { ipAddress: req.ip, userAgent: req.get('user-agent') });
  }
}

exports.establishSession = establishSession;

// Pages a visitor may be sent back to after signing in or signing up: group and
// community invites, and public-facing profile / community links that were
// shared with them. Anything else falls back to the dashboard.
const RETURN_PATHS = [
  /^\/groups\/join\/[A-Za-z0-9_-]+$/,
  /^\/communities\/invite\/[A-Za-z0-9_-]+$/,
  /^\/communities\/[a-z0-9-]+$/,
  /^\/u\/[a-f0-9]{24}$/
];
function safeReturnPath(value) {
  return typeof value === 'string' && value.length <= 200 && RETURN_PATHS.some((pattern) => pattern.test(value)) ? value : null;
}
exports.safeReturnPath = safeReturnPath;

// Where to go after signing in: a pending invite / shared link if there is one.
function landingPath(req) {
  const next = safeReturnPath(req.session.returnTo);
  delete req.session.returnTo;
  return next || '/dashboard';
}
exports.landingPath = landingPath;

function rememberNext(req) {
  const next = safeReturnPath(req.query.next);
  if (next) req.session.returnTo = next;
}
exports.loginPage = (req, res) => { rememberNext(req); res.render('pages/login', { title: 'Sign in', socialProviders: enabledProviders(), socialNext: safeReturnPath(req.query.next) }); };
exports.registerPage = (req, res) => {
  rememberNext(req);
  const managed = turnstileEnabled();
  if (managed) req.session.registerFormShownAt = Date.now();
  res.render('pages/register', { title: 'Create your account', captcha: managed ? null : generateChallenge(req), turnstileSiteKey: managed ? turnstileSiteKey() : '', socialProviders: enabledProviders(), socialNext: safeReturnPath(req.query.next) });
};
exports.verifyPage = (req, res) => res.render('pages/verify', { title: 'Verify your email', email: req.query.email || '' });
exports.forgotPage = (req, res) => res.render('pages/forgot-password', { title: 'Reset your password' });
exports.resetPage = (req, res) => res.render('pages/reset-password', { title: 'Choose a new password', token: req.query.token || '' });

exports.register = async (req, res) => {
  try {
    const name = asText(req.body.name, 100).trim();
    const email = asText(req.body.email);
    const password = asText(req.body.password, 1000);
    const automated = looksAutomated(req);
    delete req.session.registerFormShownAt;
    const humanVerified = turnstileEnabled()
      ? await verifyTurnstile(req.body['cf-turnstile-response'], req.ip)
      : verifyChallenge(req, req.body.captchaAnswer);
    if (automated || !humanVerified) {
      setFlash(req, 'error', 'That verification answer was not correct. Try again.');
      return res.redirect('/auth/register');
    }
    if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
      setFlash(req, 'error', 'Add your name and a valid email address.');
      return res.redirect('/auth/register');
    }
    const weak = passwordProblem(password, { email, name });
    if (weak) {
      setFlash(req, 'error', weak);
      return res.redirect('/auth/register');
    }
    if (!req.body.acceptTerms) {
      setFlash(req, 'error', 'You need to agree to the Terms of Service and Privacy Policy to create an account.');
      return res.redirect('/auth/register');
    }
    const normalizedEmail = email.toLowerCase().trim();
    let user = await User.findOne({ email: normalizedEmail });
    if (user?.isVerified) {
      setFlash(req, 'error', 'An account with that email already exists.');
      return res.redirect('/auth/login');
    }
    const verificationCode = code();
    if (!user) user = new User({ name, email: normalizedEmail, password: await hashPassword(password), username: await generateUniqueUsername(normalizedEmail.split('@')[0] || name) });
    else if (!user.username) user.username = await generateUniqueUsername(normalizedEmail.split('@')[0] || name);
    user.verificationCode = verificationCode;
    user.verificationExpires = Date.now() + 15 * 60 * 1000;
    user.verificationAttempts = 0;
    await user.save();
    sendVerificationCode(user, verificationCode); // not awaited - see mailer.js
    setFlash(req, 'success', 'Your verification code is on its way.');
    res.redirect(`/auth/verify?email=${encodeURIComponent(user.email)}`);
  } catch (error) {
    logger.error('Auth action failed', error);
    setFlash(req, 'error', 'We could not create your account right now.');
    res.redirect('/auth/register');
  }
};

exports.login = async (req, res) => {
  try {
    const email = asText(req.body.email).toLowerCase().trim();
    const password = asText(req.body.password, 1000);
    const user = email ? await User.findOne({ email }) : null;
    if (user?.loginLockedUntil && user.loginLockedUntil > Date.now()) {
      setFlash(req, 'error', 'Too many failed attempts. Try again later.');
      return res.redirect('/auth/login');
    }
    // Always run one bcrypt comparison so an unknown email is not faster than a wrong password.
    const passwordOk = await bcrypt.compare(password, user ? user.password : DUMMY_HASH);
    if (!user || !passwordOk) {
      if (user) {
        user.loginAttempts = (user.loginAttempts || 0) + 1;
        if (user.loginAttempts >= 5) {
          user.loginLockedUntil = Date.now() + 15 * 60 * 1000;
          user.loginAttempts = 0;
          if (user.isVerified && user.notificationPreferences?.security !== false) {
            sendSecurityAlert(user, { subject: 'Sign-in attempts were blocked on your Crowdwide account', heading: 'Too many sign-in attempts', message: 'Someone entered the wrong password for your account 5 times, so sign-in is paused for 15 minutes. If that was you, nothing else is needed. If not, consider changing your password.', tone: 'warning' });
          }
        }
        await user.save();
      }
      setFlash(req, 'error', 'That email and password combination is not recognized.');
      return res.redirect('/auth/login');
    }
    // Only someone who proved they know the password is told about a suspension.
    if (user.suspendedUntil && user.suspendedUntil > Date.now()) {
      setFlash(req, 'error', `Your account is suspended until ${new Date(user.suspendedUntil).toLocaleString()}.${user.suspensionReason ? ` Reason: ${user.suspensionReason}` : ''}`);
      return res.redirect('/auth/login');
    }
    if (process.env.ADMIN_EMAIL && user.email === process.env.ADMIN_EMAIL.toLowerCase().trim() && user.role !== 'admin') user.role = 'admin';
    if (user.loginAttempts) user.loginAttempts = 0;
    if (user.loginLockedUntil) user.loginLockedUntil = undefined;
    if (!user.isVerified) {
      const verificationCode = code();
      user.verificationCode = verificationCode;
      user.verificationExpires = Date.now() + 15 * 60 * 1000;
      user.verificationAttempts = 0;
      await user.save();
      sendVerificationCode(user, verificationCode); // not awaited - see mailer.js
      setFlash(req, 'error', 'Your email is not verified yet. We sent you a fresh code.');
      return res.redirect(`/auth/verify?email=${encodeURIComponent(user.email)}`);
    }
    if (user.isModified()) await user.save();
    if (user.twoFactorEnabled) {
      req.session.pendingTwoFactorUser = user.id;
      req.session.pendingTwoFactorExpiresAt = Date.now() + 10 * 60 * 1000;
      return res.redirect('/auth/2fa');
    }
    await establishSession(req, user);
    res.redirect(landingPath(req));
  } catch (error) {
    logger.error('Sign in failed', error);
    setFlash(req, 'error', 'Sign in is temporarily unavailable.');
    res.redirect('/auth/login');
  }
};

// Marks the address as confirmed, gives the welcome bonus, signs the member in and starts onboarding.
async function finishVerification(req, res, user) {
  user.isVerified = true;
  user.verificationCode = undefined;
  user.verificationExpires = undefined;
  user.verificationAttempts = 0;
  user.verificationLinkHash = undefined;
  user.verificationLinkExpires = undefined;
  await user.save();
  let welcome = { granted: false, amount: 0 };
  try { welcome = await grantWelcomeBonus(user._id); } catch (bonusError) { logger.warn('Welcome bonus could not be granted', bonusError); }
  await establishSession(req, user);
  evaluateBadges(user._id).catch((error) => logger.warn('Badge check after verification failed', error));
  if (welcome.granted) setFlash(req, 'success', `Welcome to Crowdwide! ${welcome.amount.toLocaleString()} Waves were added to your wallet. Earn more by posting, commenting and joining communities - see how in your wallet.`);
  // New members start with onboarding (interests, people, communities); it hands them on to
  // wherever they were heading (or the dashboard) when they finish.
  return res.redirect('/welcome');
}

exports.verify = async (req, res) => {
  const email = asText(req.body.email).toLowerCase().trim();
  try {
    const user = email ? await User.findOne({ email }) : null;
    const submitted = asText(req.body.code, 12).trim();
    const live = user && !user.isVerified && user.verificationCode && user.verificationExpires && user.verificationExpires >= Date.now() && (user.verificationAttempts || 0) < MAX_VERIFY_ATTEMPTS;
    if (!live || !sameText(user.verificationCode, submitted)) {
      if (live) {
        // Count the wrong guess; after 5 the code is void and a new one has to be requested.
        user.verificationAttempts = (user.verificationAttempts || 0) + 1;
        if (user.verificationAttempts >= MAX_VERIFY_ATTEMPTS) { user.verificationCode = undefined; user.verificationExpires = undefined; }
        await user.save();
        setFlash(req, 'error', user.verificationAttempts >= MAX_VERIFY_ATTEMPTS ? 'Too many wrong codes. Request a new code to try again.' : 'That code is not correct.');
      } else {
        setFlash(req, 'error', 'That code is invalid or has expired.');
      }
      return res.redirect(`/auth/verify?email=${encodeURIComponent(email)}`);
    }
    return await finishVerification(req, res, user);
  } catch (error) {
    logger.error('Email verification failed', error);
    setFlash(req, 'error', 'We could not verify that code right now.');
    res.redirect('/auth/verify');
  }
};

// One-click link from the reminder emails. GET only shows a confirm button (mail scanners
// and link previewers open links without anyone clicking); the POST does the work.
async function userForLink(req) {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  const user = await User.findById(req.params.id);
  return user && !user.isVerified && linkMatches(user, req.params.token) ? user : null;
}

exports.verifyLinkPage = async (req, res) => {
  try {
    const user = await userForLink(req);
    if (!user) {
      setFlash(req, 'error', 'That verification link has expired or was already used. Sign in and we will send you a fresh code.');
      return res.redirect('/auth/login');
    }
    res.render('pages/verify-link', { title: 'Confirm your email', firstName: (user.name || '').split(/\s+/)[0], action: `/auth/verify-email/${user.id}/${req.params.token}` });
  } catch (error) {
    logger.error('Verification link page failed', error);
    res.redirect('/auth/login');
  }
};

exports.verifyLink = async (req, res) => {
  try {
    const user = await userForLink(req);
    if (!user) {
      setFlash(req, 'error', 'That verification link has expired or was already used. Sign in and we will send you a fresh code.');
      return res.redirect('/auth/login');
    }
    return await finishVerification(req, res, user);
  } catch (error) {
    logger.error('Verification link failed', error);
    setFlash(req, 'error', 'We could not verify your email right now. Please try again.');
    res.redirect('/auth/login');
  }
};

exports.resendCode = async (req, res) => {
  const email = asText(req.body.email).toLowerCase().trim();
  try {
    const user = email ? await User.findOne({ email }) : null;
    if (user && !user.isVerified) {
      const verificationCode = code();
      user.verificationCode = verificationCode;
      user.verificationExpires = Date.now() + 15 * 60 * 1000;
      user.verificationAttempts = 0;
      await user.save();
      sendVerificationCode(user, verificationCode); // not awaited - see mailer.js
    }
    // Same message either way so this can't be used to discover which emails have accounts.
    setFlash(req, 'success', 'If that email is waiting for verification, a new code is on its way.');
  } catch (error) {
    logger.error('Resending verification code failed', error);
    setFlash(req, 'error', 'We could not send a new code right now.');
  }
  res.redirect(`/auth/verify?email=${encodeURIComponent(email || '')}`);
};

exports.forgot = async (req, res) => {
  try {
    const email = asText(req.body.email).toLowerCase().trim();
    const user = email ? await User.findOne({ email }) : null;
    if (user) {
      const raw = token();
      // Only a hash is stored: a leaked database copy cannot be used to reset anyone's password.
      user.resetToken = sha256(raw);
      user.resetExpires = Date.now() + 30 * 60 * 1000;
      await user.save();
      const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
      sendPasswordResetLink(user, `${appUrl}/auth/reset?token=${raw}`); // not awaited - see mailer.js
    }
    setFlash(req, 'success', 'If that email belongs to Crowdwide, a reset link is on its way.');
    res.redirect('/auth/forgot-password');
  } catch (error) {
    logger.error('Auth action failed', error);
    setFlash(req, 'error', 'We could not process that request right now.');
    res.redirect('/auth/forgot-password');
  }
};

exports.reset = async (req, res) => {
  const rawToken = asText(req.body.token, 200);
  try {
    const password = asText(req.body.password, 1000);
    const user = rawToken ? await User.findOne({ resetToken: sha256(rawToken), resetExpires: { $gt: Date.now() } }) : null;
    const weak = user ? passwordProblem(password, { email: user.email, name: user.name }) : '';
    if (!user || weak) {
      setFlash(req, 'error', weak || 'That reset link is invalid or has expired.');
      return res.redirect(`/auth/reset?token=${encodeURIComponent(rawToken)}`);
    }
    user.password = await hashPassword(password);
    user.passwordSet = true;
    user.resetToken = undefined;
    user.resetExpires = undefined;
    user.loginAttempts = 0;
    user.loginLockedUntil = undefined;
    await user.save();
    // A reset usually means "someone else may have my password": sign out every device.
    await revokeSessions(req, user._id, { keepCurrent: false }).catch((error) => logger.warn('Could not sign out devices after a reset', error));
    logEvent(user._id, 'password-changed', 'Via password-reset link');
    if (user.notificationPreferences?.security !== false) {
      sendSecurityAlert(user, {
        subject: 'Your Crowdwide password was reset',
        heading: 'Password reset',
        message: 'Your Crowdwide password was just reset and every device was signed out. If you did not do this, secure your account immediately by resetting your password again.'
      });
    }
    setFlash(req, 'success', 'Your password has been updated. Sign in with the new one.');
    res.redirect('/auth/login');
  } catch (error) {
    logger.error('Auth action failed', error);
    setFlash(req, 'error', 'We could not reset your password right now.');
    res.redirect(`/auth/reset?token=${encodeURIComponent(rawToken)}`);
  }
};

exports.logout = async (req, res) => {
  await LoginSession.deleteOne({ sessionId: req.sessionID });
  req.session.destroy(() => res.redirect('/'));
};
