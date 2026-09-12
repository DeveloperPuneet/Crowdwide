const bcrypt = require('bcryptjs');
const User = require('../models/User');
const LoginSession = require('../models/LoginSession');
const Post = require('../models/Post');
const Community = require('../models/Community');
const { uploadBuffer, mediaUrl } = require('../services/storageCluster');

const flash = (req, type, message) => { req.session.flash = { type, message }; };

async function settingsData(req) {
  const user = await User.findById(req.session.user.id).lean();
  const sessions = await LoginSession.find({ user: user._id }).sort({ lastSeenAt: -1 }).lean();
  const ownedCommunities = await Community.find({ owner: user._id }).sort({ createdAt: -1 }).lean();
  const blockedUsers = user.blockedUsers?.length ? await User.find({ _id: { $in: user.blockedUsers } }).select('name profilePicture').lean() : [];
  return { user, sessions, ownedCommunities, blockedUsers };
}

exports.page = async (req, res) => {
  const data = await settingsData(req);
  res.render('pages/settings', { title: 'Settings', pagePath: '/settings', noIndex: true, section: req.params.section || 'profile', sessionID: req.sessionID, ...data });
};

exports.updateProfile = async (req, res) => {
  const user = await User.findById(req.session.user.id);
  user.name = req.body.name?.trim() || user.name;
  user.bio = req.body.bio?.trim() || '';
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

exports.changePassword = async (req, res) => {
  const user = await User.findById(req.session.user.id);
  if (!user || !(await bcrypt.compare(req.body.currentPassword || '', user.password)) || !req.body.newPassword || req.body.newPassword.length < 8) {
    flash(req, 'error', 'Check your current password and use a new password of at least 8 characters.');
    return res.redirect('/settings/security');
  }
  user.password = await bcrypt.hash(req.body.newPassword, 12);
  await user.save();
  flash(req, 'success', 'Password changed. Other devices remain signed in until you log them out.');
  res.redirect('/settings/security');
};

exports.logoutDevice = async (req, res) => {
  const device = await LoginSession.findOne({ _id: req.params.id, user: req.session.user.id });
  if (device && device.sessionId !== req.sessionID) await LoginSession.deleteOne({ _id: device._id });
  flash(req, 'success', 'That device has been logged out.');
  res.redirect('/settings/security');
};

exports.logoutAll = async (req, res) => {
  await LoginSession.deleteMany({ user: req.session.user.id, sessionId: { $ne: req.sessionID } });
  flash(req, 'success', 'All other devices have been logged out.');
  res.redirect('/settings/security');
};

exports.setInactivity = async (req, res) => {
  const days = Number(req.body.inactivityLogoutDays);
  await User.findByIdAndUpdate(req.session.user.id, { inactivityLogoutDays: [0, 7, 30, 90].includes(days) ? days : 0 });
  flash(req, 'success', 'Inactivity preference saved.');
  res.redirect('/settings/privacy');
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
  await Promise.all([
    User.deleteOne({ _id: userId }),
    LoginSession.deleteMany({ user: userId }),
    Post.deleteMany({ author: userId }),
    Community.deleteMany({ owner: userId })
  ]);
  req.session.destroy(() => res.redirect('/'));
};
