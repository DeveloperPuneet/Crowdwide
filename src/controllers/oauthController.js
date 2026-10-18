// "Continue with Google / GitHub" - sign in, or create an account, with a
// provider's verified email. See src/services/oauth.js for the provider side.
//
// Flow:  GET /auth/:provider            -> redirect to the provider
//        GET /auth/:provider/callback   -> known identity or matching email: sign in
//                                          otherwise: park the profile in the session
//        GET/POST /auth/social/confirm  -> new people review their details and accept
//                                          the Terms before the account is created
const crypto = require('crypto');
const User = require('../models/User');
const logger = require('../services/logger');
const oauth = require('../services/oauth');
const { grantWelcomeBonus } = require('../services/waves');
const { generateUniqueUsername } = require('../services/username');
const { sendSecurityAlert } = require('../services/mailer');
const { logEvent } = require('../services/accountHistory');
const { hashPassword } = require('../utils/passwords');
const { establishSession, landingPath, safeReturnPath } = require('./authController');

const ATTEMPT_TTL_MS = 10 * 60 * 1000;
const PENDING_TTL_MS = 15 * 60 * 1000;
const setFlash = (req, type, message) => { req.session.flash = { type, message }; };
const fail = (req, res, message, to = '/auth/login') => { setFlash(req, 'error', message); return res.redirect(to); };

const isAdminEmail = (email) => Boolean(process.env.ADMIN_EMAIL) && email === process.env.ADMIN_EMAIL.toLowerCase().trim();
const suspensionMessage = (user) => `Your account is suspended until ${new Date(user.suspendedUntil).toLocaleString()}.${user.suspensionReason ? ` Reason: ${user.suspensionReason}` : ''}`;
const randomPasswordHash = () => hashPassword(crypto.randomBytes(32).toString('hex'));

// Step 1: send the visitor to the provider.
exports.start = (req, res) => {
  const id = req.params.provider;
  if (!oauth.isKnownProvider(id) || !oauth.isEnabled(id)) return fail(req, res, 'That sign-in option is not available.');
  const next = safeReturnPath(req.query.next);
  if (next) req.session.returnTo = next;
  const attempt = oauth.newAttempt();
  req.session.oauthAttempt = { provider: id, state: attempt.state, verifier: attempt.verifier, startedAt: Date.now() };
  return res.redirect(oauth.buildAuthorizeUrl(id, attempt));
};

// Step 2: the provider sends the visitor back with ?code&state.
exports.callback = async (req, res) => {
  const id = req.params.provider;
  const attempt = req.session.oauthAttempt;
  delete req.session.oauthAttempt; // single use, whatever happens next
  try {
    if (!oauth.isKnownProvider(id) || !oauth.isEnabled(id)) return fail(req, res, 'That sign-in option is not available.');
    if (req.query.error) return fail(req, res, `${oauth.providerLabel(id)} sign-in was cancelled. You can try again or use your email and password.`);
    const valid = attempt && attempt.provider === id && Date.now() - attempt.startedAt < ATTEMPT_TTL_MS && oauth.statesMatch(attempt.state, req.query.state);
    if (!valid || typeof req.query.code !== 'string' || !req.query.code) return fail(req, res, 'That sign-in link expired or was not valid. Please try again.');

    const profile = await oauth.fetchProfile(id, req.query.code, { verifier: attempt.verifier });
    if (!profile.email || !profile.emailVerified) {
      return fail(req, res, `${oauth.providerLabel(id)} did not give us a verified email address, so we cannot sign you in with it. Verify an email on your ${oauth.providerLabel(id)} account, or sign up with email instead.`);
    }
    return await signInOrStartSignup(req, res, profile);
  } catch (error) {
    if (error instanceof oauth.OAuthError) {
      logger.warn('Social sign-in failed', { provider: id, error: error.cause || error });
      return fail(req, res, error.message);
    }
    logger.error('Social sign-in failed', error);
    return fail(req, res, 'Sign in is temporarily unavailable.');
  }
};

async function signInOrStartSignup(req, res, profile) {
  let user = await User.findOne({ socialLogins: { $elemMatch: { provider: profile.provider, providerId: profile.providerId } } });
  let linkedNow = false;
  let verifiedNow = false;

  if (!user) {
    // The provider vouches for this email, so it can be attached to the
    // existing account that owns it.
    user = await User.findOne({ email: profile.email });
    if (!user) {
      req.session.pendingSocialSignup = { profile, expiresAt: Date.now() + PENDING_TTL_MS };
      return res.redirect('/auth/social/confirm');
    }
    if ((user.socialLogins || []).some((entry) => entry.provider === profile.provider)) {
      return fail(req, res, `A different ${oauth.providerLabel(profile.provider)} account is already connected to that email. Sign in with the one you used before.`);
    }
    if (user.suspendedUntil && user.suspendedUntil > Date.now()) return fail(req, res, suspensionMessage(user));
    if (!user.isVerified) {
      // Someone registered this email with a password but never proved they own
      // it. The provider just proved the real owner does - so the unproven
      // password (which may belong to a squatter) must not survive.
      user.password = await randomPasswordHash();
      user.passwordSet = false;
      user.isVerified = true;
      user.verificationCode = undefined;
      user.verificationExpires = undefined;
      user.resetToken = undefined;
      user.resetExpires = undefined;
      verifiedNow = true;
    }
    user.socialLogins.push({ provider: profile.provider, providerId: profile.providerId, email: profile.email });
    linkedNow = true;
  }

  if (user.suspendedUntil && user.suspendedUntil > Date.now()) return fail(req, res, suspensionMessage(user));
  if (isAdminEmail(user.email) && user.role !== 'admin') user.role = 'admin';
  if (user.loginAttempts) user.loginAttempts = 0;
  if (linkedNow || user.isModified()) await user.save();

  if (linkedNow) {
    logEvent(user._id, 'social-login-linked', `${oauth.providerLabel(profile.provider)} (${profile.email})`);
    if (user.notificationPreferences?.security !== false) {
      sendSecurityAlert(user, { // not awaited - see mailer.js
        subject: `${oauth.providerLabel(profile.provider)} sign-in connected to Crowdwide`,
        heading: 'New way to sign in',
        message: `You can now sign in to Crowdwide with your ${oauth.providerLabel(profile.provider)} account (${profile.email}).`,
        note: 'If this was not you, reset your password right away and review your active sessions in Settings.'
      });
    }
  }

  if (user.twoFactorEnabled) {
    req.session.pendingTwoFactorUser = user.id;
    req.session.pendingTwoFactorExpiresAt = Date.now() + 10 * 60 * 1000;
    return res.redirect('/auth/2fa');
  }

  await establishSession(req, user);
  if (verifiedNow) return welcomeNewMember(req, res, user);
  return res.redirect(landingPath(req));
}

async function welcomeNewMember(req, res, user) {
  let welcome = { granted: false, amount: 0 };
  try { welcome = await grantWelcomeBonus(user._id); } catch (bonusError) { logger.warn('Welcome bonus could not be granted', bonusError); }
  if (welcome.granted) setFlash(req, 'success', `Welcome to Crowdwide! ${welcome.amount.toLocaleString()} Waves were added to your wallet. Earn more by posting, commenting and joining communities - see how in your wallet.`);
  return res.redirect('/welcome');
}

const pendingSignup = (req) => {
  const pending = req.session.pendingSocialSignup;
  if (!pending || !pending.profile || !(pending.expiresAt > Date.now())) {
    delete req.session.pendingSocialSignup;
    return null;
  }
  return pending;
};

// Step 3 (new people only): confirm the name and accept the Terms.
exports.confirmPage = (req, res) => {
  const pending = pendingSignup(req);
  if (!pending) return fail(req, res, 'That sign-up expired. Please start again.', '/auth/register');
  return res.render('pages/social-confirm', {
    title: 'Finish signing up',
    pagePath: '/auth/social/confirm',
    providerLabel: oauth.providerLabel(pending.profile.provider),
    profile: pending.profile
  });
};

exports.confirm = async (req, res) => {
  const pending = pendingSignup(req);
  if (!pending) return fail(req, res, 'That sign-up expired. Please start again.', '/auth/register');
  const { profile } = pending;
  try {
    if (!req.body.acceptTerms) return fail(req, res, 'You need to agree to the Terms of use and Privacy policy to create an account.', '/auth/social/confirm');
    const name = String(req.body.name || '').trim().slice(0, 60);
    if (!name) return fail(req, res, 'Add the name you would like to go by.', '/auth/social/confirm');

    // Someone may have registered this email while the form was open.
    if (await User.exists({ email: profile.email })) {
      delete req.session.pendingSocialSignup;
      return fail(req, res, 'An account with that email already exists. Sign in to continue.');
    }

    const user = new User({
      name,
      email: profile.email,
      password: await randomPasswordHash(),
      passwordSet: false,
      username: await generateUniqueUsername(profile.email.split('@')[0] || name),
      isVerified: true,
      socialLogins: [{ provider: profile.provider, providerId: profile.providerId, email: profile.email }]
    });
    if (isAdminEmail(profile.email)) user.role = 'admin';
    await user.save();
    delete req.session.pendingSocialSignup;

    await establishSession(req, user);
    return await welcomeNewMember(req, res, user);
  } catch (error) {
    if (error?.code === 11000) return fail(req, res, 'An account with that email already exists. Sign in to continue.');
    logger.error('Social sign-up failed', error);
    return fail(req, res, 'We could not create your account right now.', '/auth/social/confirm');
  }
};
