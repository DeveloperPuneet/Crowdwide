const { normalizeUsername, validateUsername, ensureUsername } = require('../services/username');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { hashPassword } = require('../utils/passwords');
const { passwordProblem } = require('../utils/passwordPolicy');
const { revokeSessions } = require('../services/sessions');
const { evaluateBadges, forgetBadgeCheck } = require('../services/badgeSweep');
const User = require('../models/User');
const LoginSession = require('../models/LoginSession');
const Post = require('../models/Post');
const Community = require('../models/Community');
const Message = require('../models/Message');
const GroupConversation = require('../models/GroupConversation');
const GroupMessage = require('../models/GroupMessage');
const { uploadBuffer, mediaUrl } = require('../services/storageCluster');
const { parseHashtagList } = require('../utils/hashtags');
const { sendSecurityAlert } = require('../services/mailer');
const { isPushConfigured, getPublicKey } = require('../services/push');
const Appeal = require('../models/Appeal');
const AccountEvent = require('../models/AccountEvent');
const logger = require('../services/logger');
const { logEvent } = require('../services/accountHistory');
const countWords = require('../utils/wordCount');
const { isValidTimezone } = require('../services/newsletterWorker');
const { removeUserFromCommunities } = require('../services/communityMembership');

const flash = (req, type, message) => { req.session.flash = { type, message }; };

async function settingsData(req) {
  const user = await User.findById(req.session.user.id).lean();
  const sessions = await LoginSession.find({ user: user._id }).sort({ lastSeenAt: -1 }).lean();
  const ownedCommunities = await Community.find({ owner: user._id }).sort({ createdAt: -1 }).lean();
  const blockedUsers = user.blockedUsers?.length ? await User.find({ _id: { $in: user.blockedUsers } }).select('name profilePicture').lean() : [];
  const appeals = await Appeal.find({ user: user._id }).sort({ createdAt: -1 }).limit(20).lean();
  const accountEvents = await AccountEvent.find({ user: user._id }).sort({ createdAt: -1 }).limit(50).lean();
  return { user, sessions, ownedCommunities, blockedUsers, appeals, accountEvents };
}

exports.page = async (req, res) => {
  await ensureUsername(req.session.user.id).catch(() => null);
  const data = await settingsData(req);
  res.render('pages/settings', { title: 'Settings', pagePath: '/settings', noIndex: true, section: req.params.section || 'profile', sessionID: req.sessionID, pushConfigured: isPushConfigured(), pushPublicKey: getPublicKey(), ...data });
};

exports.updateProfile = async (req, res) => {
  const bio = req.body.bio?.trim() || '';
  if (countWords(bio) > 40) {
    flash(req, 'error', 'Your bio can be up to 40 words. Please shorten it and try again.');
    return res.redirect('/settings/profile');
  }
  const user = await User.findById(req.session.user.id);
  user.name = req.body.name?.trim() || user.name;
  if (req.body.username !== undefined && normalizeUsername(req.body.username) !== (user.username || '')) {
    const check = validateUsername(req.body.username);
    if (!check.ok) {
      flash(req, 'error', check.error);
      return res.redirect('/settings/profile');
    }
    if (await User.exists({ username: check.username, _id: { $ne: user._id } })) {
      flash(req, 'error', 'That username is already taken.');
      return res.redirect('/settings/profile');
    }
    user.username = check.username;
  }
  user.bio = bio;
  user.hashtags = parseHashtagList(req.body.hashtags || '');
  user.privacy = ['public', 'followers'].includes(req.body.privacy) ? req.body.privacy : user.privacy;

  const links = [];
  for (let i = 0; i < 4; i += 1) {
    const label = req.body[`linkLabel${i}`]?.trim();
    let url = req.body[`linkUrl${i}`]?.trim();
    if (label && url) {
      if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
      links.push({ label: label.slice(0, 40), url: url.slice(0, 300) });
    }
  }
  user.links = links;

  const picture = req.files?.profilePicture?.[0];
  const banner = req.files?.bannerImage?.[0];
  if (picture) {
    const stored = await uploadBuffer(picture.buffer, picture.originalname, picture.mimetype, { kind: 'profile-picture', owner: user._id.toString() });
    user.profilePicture = mediaUrl(stored);
  }
  if (banner) {
    const stored = await uploadBuffer(banner.buffer, banner.originalname, banner.mimetype, { kind: 'profile-banner', owner: user._id.toString() });
    user.bannerImage = mediaUrl(stored);
  }
  await user.save();
  req.session.user.name = user.name;
  req.session.user.profilePicture = user.profilePicture;
  flash(req, 'success', 'Your profile has been updated.');
  res.redirect('/settings/profile');
};

// Admins and moderators who signed in with Google or GitHub have no password the panel
// can ask for. Until they choose one, a blocking prompt asks them to set it; it then
// doubles as their panel password (and lets them sign in with email + password too).
exports.setPanelPassword = async (req, res) => {
  const back = () => (req.get('X-Requested-With') === 'XMLHttpRequest' ? null : res.redirect(req.get('referer') || '/dashboard'));
  const fail = (message) => {
    if (req.get('X-Requested-With') === 'XMLHttpRequest') return res.status(400).json({ ok: false, error: message });
    flash(req, 'error', message);
    return back();
  };
  try {
    const user = await User.findById(req.session.user.id);
    if (!user || !['admin', 'moderator'].includes(user.role)) return fail('Only admins and moderators need a panel password.');
    if (user.passwordSet !== false) return fail('You already have a password. Change it in Settings → Security.');
    const password = String(req.body.newPassword || '');
    if (password.length < 8 || password.length > 200) return fail('Use a password of at least 8 characters.');
    if (password !== String(req.body.confirmPassword || '')) return fail('The two passwords do not match.');
    user.password = await hashPassword(password);
    user.passwordSet = true;
    await user.save();
    logEvent(user._id, 'password-changed', 'Panel password set after social sign-in');
    if (user.notificationPreferences?.security !== false) {
      sendSecurityAlert(user, {
        subject: 'A password was set on your Crowdwide account',
        heading: 'Panel password set',
        message: 'A password was just set on your Crowdwide account. It is now used to open the admin and moderator panels. If you did not do this, reset your password immediately and review your active sessions.'
      });
    }
    if (req.get('X-Requested-With') === 'XMLHttpRequest') return res.json({ ok: true });
    flash(req, 'success', 'Panel password set. You can now open the panel.');
    return back();
  } catch (error) {
    logger.error('Setting panel password failed', error);
    return fail('Could not set your password right now.');
  }
};

exports.changePassword = async (req, res) => {
  try {
    const user = await User.findById(req.session.user.id);
    if (user && user.passwordSet === false) {
      flash(req, 'error', 'You signed up with Google or GitHub, so there is no password to change yet. Use "Forgot password" on the sign-in page to create one.');
      return res.redirect('/settings/security');
    }
    const currentPassword = typeof req.body.currentPassword === 'string' ? req.body.currentPassword.slice(0, 1000) : '';
    const newPassword = typeof req.body.newPassword === 'string' ? req.body.newPassword.slice(0, 1000) : '';
    if (!user || !(await bcrypt.compare(currentPassword, user.password))) {
      flash(req, 'error', 'Your current password is not correct.');
      return res.redirect('/settings/security');
    }
    const weak = passwordProblem(newPassword, { email: user.email, name: user.name });
    if (weak) {
      flash(req, 'error', weak);
      return res.redirect('/settings/security');
    }
    user.password = await hashPassword(newPassword);
    await user.save();
    // Changing the password signs out every other device (this one stays).
    await revokeSessions(req, user._id).catch((error) => logger.warn('Could not sign out other devices', error));
    logEvent(user._id, 'password-changed', 'Via Settings');
    if (user.notificationPreferences?.security !== false) {
      sendSecurityAlert(user, {
        subject: 'Your Crowdwide password was changed',
        heading: 'Password changed',
        message: 'Your Crowdwide password was just changed. If you did not make this change, reset your password immediately and review your active sessions.'
      });
    }
    flash(req, 'success', 'Password changed. Your other devices were signed out.');
    res.redirect('/settings/security');
  } catch (error) {
    logger.error('Settings action failed', error);
    flash(req, 'error', 'Could not change your password right now.');
    res.redirect('/settings/security');
  }
};

// Called by public/js/timezone.js with the browser's IANA zone so the weekly
// newsletter can arrive at 10:30 on the member's own clock.
exports.setTimezone = async (req, res) => {
  const zone = String(req.body?.timezone || '').trim();
  if (!isValidTimezone(zone)) return res.status(400).json({ error: 'Unknown time zone.' });
  await User.updateOne({ _id: req.session.user.id }, { $set: { timezone: zone } });
  res.status(204).end();
};

exports.logoutDevice = async (req, res) => {
  if (mongoose.isValidObjectId(req.params.id)) await revokeSessions(req, req.session.user.id, { only: req.params.id });
  flash(req, 'success', 'That device has been logged out.');
  res.redirect('/settings/security');
};

exports.logoutAll = async (req, res) => {
  await revokeSessions(req, req.session.user.id);
  flash(req, 'success', 'All other devices have been logged out.');
  res.redirect('/settings/security');
};

exports.setInactivity = async (req, res) => {
  const days = Number(req.body.inactivityLogoutDays);
  await User.findByIdAndUpdate(req.session.user.id, { inactivityLogoutDays: [0, 7, 30, 90].includes(days) ? days : 0 });
  flash(req, 'success', 'Inactivity preference saved.');
  res.redirect('/settings/privacy');
};

exports.setNotifications = async (req, res) => {
  const commentNotifications = ['all', 'mentions', 'off'].includes(req.body.commentNotifications)
    ? req.body.commentNotifications
    : req.body.notifyComments === 'on' ? 'all' : 'off';
  await User.findByIdAndUpdate(req.session.user.id, {
    notificationPreferences: {
      likes: req.body.notifyLikes === 'on',
      comments: commentNotifications !== 'off',
      mentionsOnly: commentNotifications === 'mentions',
      follows: req.body.notifyFollows === 'on',
      messages: req.body.notifyMessages === 'on',
      security: req.body.notifySecurity === 'on',
      emailNewsletter: req.body.emailNewsletter === 'on',
      emailUnreadSummary: req.body.emailUnreadSummary === 'on',
      emailReminders: req.body.emailReminders === 'on',
      emailWelcome: req.body.emailWelcome === 'on'
    }
  });
  flash(req, 'success', 'Notification preferences saved.');
  res.redirect('/settings/notifications');
};

exports.setTheme = async (req, res) => {
  const theme = ['default', 'light', 'dark', 'violet', 'pink'].includes(req.body.theme) ? req.body.theme : 'default';
  await User.findByIdAndUpdate(req.session.user.id, { theme });
  req.session.user.theme = theme;
  flash(req, 'success', 'Theme preference saved.');
  res.redirect('/settings/account');
};

exports.downloadData = async (req, res) => {
  const user = await User.findById(req.session.user.id).lean();
  const [posts, communities] = await Promise.all([
    Post.find({ author: user._id }).select('body type community createdAt').lean(),
    Community.find({ owner: user._id }).select('name slug description createdAt').lean()
  ]);
  await User.updateOne({ _id: user._id }, { dataDownloadRequestedAt: new Date() });
  res.attachment('crowdwide-data.json').json({ exportedAt: new Date().toISOString(), account: { name: user.name, email: user.email, bio: user.bio, createdAt: user.createdAt }, posts, communities });
};

exports.deleteAccount = async (req, res) => {
  const userId = req.session.user.id;
  if (req.body.confirm !== 'DELETE') {
    flash(req, 'error', 'Type DELETE to confirm account deletion.');
    return res.redirect('/settings/account');
  }
  // Deleting is permanent, so a hijacked session alone must not be enough: password accounts re-enter it.
  const account = await User.findById(userId).select('password passwordSet');
  if (account && account.passwordSet !== false && !(await bcrypt.compare(typeof req.body.password === 'string' ? req.body.password.slice(0, 1000) : '', account.password))) {
    flash(req, 'error', 'Enter your current password to delete your account.');
    return res.redirect('/settings/account');
  }
  await revokeSessions(req, userId, { keepCurrent: false }).catch(() => {});
  await Promise.all([
    User.deleteOne({ _id: userId }),
    LoginSession.deleteMany({ user: userId }),
    Post.deleteMany({ author: userId }),
    removeUserFromCommunities(userId),
    Community.deleteMany({ owner: userId }),
    Message.deleteMany({ $or: [{ sender: userId }, { recipient: userId }] }),
    GroupMessage.deleteMany({ sender: userId }),
    GroupConversation.deleteMany({ creator: userId }),
    GroupConversation.updateMany({ members: userId }, { $pull: { members: userId } })
  ]);
  req.session.destroy(() => res.redirect('/'));
};

exports.pushPublicKey = (req, res) => {
  const publicKey = getPublicKey();
  if (!publicKey) return res.status(503).json({ error: 'Push notifications are not configured on this server.' });
  res.json({ publicKey });
};

exports.pushSubscribe = async (req, res) => {
  if (!isPushConfigured()) return res.status(503).json({ error: 'Push notifications are not configured on this server.' });
  const { endpoint, keys } = req.body?.subscription || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) return res.status(400).json({ error: 'Invalid push subscription.' });
  await User.findByIdAndUpdate(req.session.user.id, {
    pushNotificationsEnabled: true,
    $pull: { pushSubscriptions: { endpoint } }
  });
  await User.findByIdAndUpdate(req.session.user.id, {
    $push: { pushSubscriptions: { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } } }
  });
  res.json({ ok: true });
};

exports.pushUnsubscribe = async (req, res) => {
  const endpoint = req.body?.endpoint;
  const update = endpoint ? { $pull: { pushSubscriptions: { endpoint } } } : { pushSubscriptions: [], pushNotificationsEnabled: false };
  const user = await User.findByIdAndUpdate(req.session.user.id, update, { new: true }).select('pushSubscriptions');
  if (endpoint && !user.pushSubscriptions.length) await User.findByIdAndUpdate(req.session.user.id, { pushNotificationsEnabled: false });
  res.json({ ok: true });
};
