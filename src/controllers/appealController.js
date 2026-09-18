const User = require('../models/User');
const Appeal = require('../models/Appeal');
const { logEvent } = require('../services/accountHistory');

const setFlash = (req, type, message) => { req.session.flash = { type, message }; };

// Suspended users are blocked before a session is ever created (see
// authController.login), so they have no way to reach an authenticated
// settings page. This public page/route is their only way to reach a
// human about it.
exports.publicAppealPage = (req, res) => {
  res.render('pages/appeal', { title: 'Appeal a suspension' });
};

exports.submitPublicAppeal = async (req, res) => {
  const email = req.body.email?.toLowerCase().trim();
  const message = req.body.message?.trim();
  if (email && message) {
    const user = await User.findOne({ email }).select('_id suspendedUntil suspensionReason');
    if (user?.suspendedUntil && user.suspendedUntil > Date.now()) {
      const alreadyPending = await Appeal.exists({ user: user._id, actionType: 'suspension', status: 'pending' });
      if (!alreadyPending) {
        await Appeal.create({ user: user._id, actionType: 'suspension', reasonSnapshot: user.suspensionReason || '', message: message.slice(0, 1000) });
        logEvent(user._id, 'appeal-submitted', 'suspension');
      }
    }
  }
  // Same message regardless of whether a matching, currently-suspended
  // account was found - avoids confirming or denying account existence
  // to whoever is submitting this (same reasoning as forgot-password).
  setFlash(req, 'success', "If that's an active suspension on a Crowdwide account, your appeal has been submitted for review.");
  res.redirect('/auth/appeal');
};

exports.submitAppeal = async (req, res) => {
  const actionType = req.body.actionType;
  const message = req.body.message?.trim();
  if (!['posting-restriction', 'warning'].includes(actionType) || !message) {
    setFlash(req, 'error', 'Choose what you want to appeal and include a message.');
    return res.redirect('/settings/moderation');
  }

  const user = await User.findById(req.session.user.id).select('postingRestrictedUntil postingRestrictionReason warnings');

  if (actionType === 'posting-restriction') {
    if (!user.postingRestrictedUntil || user.postingRestrictedUntil <= Date.now()) {
      setFlash(req, 'error', "You don't currently have an active posting restriction to appeal.");
      return res.redirect('/settings/moderation');
    }
    const alreadyPending = await Appeal.exists({ user: user._id, actionType: 'posting-restriction', status: 'pending' });
    if (alreadyPending) {
      setFlash(req, 'error', 'You already have a pending appeal for this restriction.');
      return res.redirect('/settings/moderation');
    }
    await Appeal.create({ user: user._id, actionType: 'posting-restriction', reasonSnapshot: user.postingRestrictionReason || '', message: message.slice(0, 1000) });
    logEvent(user._id, 'appeal-submitted', 'posting-restriction');
  } else {
    const warning = user.warnings.id(req.body.warningId);
    if (!warning) {
      setFlash(req, 'error', 'That warning could not be found.');
      return res.redirect('/settings/moderation');
    }
    const alreadyPending = await Appeal.exists({ user: user._id, actionType: 'warning', warningId: warning._id, status: 'pending' });
    if (alreadyPending) {
      setFlash(req, 'error', 'You already have a pending appeal for this warning.');
      return res.redirect('/settings/moderation');
    }
    await Appeal.create({ user: user._id, actionType: 'warning', warningId: warning._id, reasonSnapshot: warning.reason || '', message: message.slice(0, 1000) });
    logEvent(user._id, 'appeal-submitted', 'warning');
  }

  setFlash(req, 'success', 'Your appeal has been submitted for review.');
  res.redirect('/settings/moderation');
};
