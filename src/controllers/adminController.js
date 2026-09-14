const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Post = require('../models/Post');
const Community = require('../models/Community');
const Report = require('../models/Report');
const AuditLog = require('../models/AuditLog');
const ModerationAction = require('../models/ModerationAction');
const SiteSetting = require('../models/SiteSetting');

const flash = (req, type, message) => { req.session.flash = { type, message }; };
const audit = (req, action, targetType, target, details = {}) => AuditLog.create({ actor: req.roleUser._id, action, targetType, target, details, ipAddress: req.ip, userAgent: req.get('user-agent') });
const panelRoles = { admin: ['admin'], moderator: ['admin', 'moderator'] };
const postModerationActions = ['delete-post', 'suspend-user', 'rate-good-post', 'rate-bad-post', 'report-post'];
const SUSPENSION_MS = 365 * 24 * 60 * 60 * 1000;

async function applyPostModerationAction(req, action, post, reason) {
  if (action === 'delete-post') await Post.deleteOne({ _id: post._id });
  if (action === 'suspend-user') await User.findByIdAndUpdate(post.author?._id || post.author, { suspendedUntil: new Date(Date.now() + SUSPENSION_MS), suspensionReason: reason });
  if (['rate-good-post', 'rate-bad-post'].includes(action)) {
    const scoreChange = action === 'rate-good-post' ? 1 : -1;
    await Post.findByIdAndUpdate(post._id, { $inc: { moderationScore: scoreChange }, $set: { moderationStatus: scoreChange > 0 ? 'good' : 'needs-review' } });
  }
  if (action === 'report-post') {
    await Report.updateOne({ reporter: req.roleUser._id, targetType: 'post', target: post._id }, { $setOnInsert: { reporter: req.roleUser._id, targetType: 'post', target: post._id, reason } }, { upsert: true });
    await Post.findByIdAndUpdate(post._id, { $set: { moderationStatus: 'reported' } });
  }
}

exports.panelAccessPage = (req, res) => {
  const panel = req.params.panel;
  if (!panelRoles[panel]) return res.status(404).render('pages/not-found', { title: 'Page not found' });
  res.render('pages/panel-access', { title: `${panel === 'admin' ? 'Admin' : 'Moderator'} panel access`, panel, panelLabel: panel === 'admin' ? 'admin' : 'moderator' });
};

exports.panelAccess = async (req, res) => {
  const panel = req.params.panel;
  const user = await User.findById(req.session.user.id).select('password role');
  if (!user || !panelRoles[panel]?.includes(user.role)) return res.status(403).render('pages/not-found', { title: 'Access denied' });
  if (!(await bcrypt.compare(req.body.password || '', user.password))) {
    flash(req, 'error', 'That password is not correct.');
    return res.redirect(`/${panel}/access`);
  }
  req.session.panelAccess = { ...(req.session.panelAccess || {}), [panel]: Date.now() + 15 * 60 * 1000 };
  const returnTo = req.body.returnTo?.startsWith(`/${panel}`) ? req.body.returnTo : `/${panel}`;
  res.redirect(returnTo);
};

exports.moderatePost = async (req, res) => {
  const action = req.body.action;
  const reason = req.body.reason?.trim() || (action === 'rate-good-post' ? 'Meets quality criteria.' : 'Moderation action requested.');
  const post = await Post.findById(req.params.id).select('author').lean();
  if (!post || !postModerationActions.includes(action)) return res.redirect(`/posts/${req.params.id}`);
  if (req.roleUser.role === 'moderator' && String(post.author) === String(req.roleUser._id)) {
    flash(req, 'error', 'You cannot moderate your own post.');
    return res.redirect(`/posts/${req.params.id}`);
  }
  if (req.roleUser.role === 'admin') {
    await applyPostModerationAction(req, action, post, reason);
    await audit(req, action, action === 'suspend-user' ? 'user' : 'post', action === 'suspend-user' ? post.author : post._id, { reason, direct: true });
    flash(req, 'success', 'Moderation action completed.');
    return res.redirect(action === 'delete-post' ? '/dashboard' : `/posts/${req.params.id}`);
  }
  await ModerationAction.create({ moderator: req.roleUser._id, action, targetType: action === 'suspend-user' ? 'user' : 'post', target: action === 'suspend-user' ? post.author : post._id, reason });
  await audit(req, 'submit-moderation-action', action === 'suspend-user' ? 'user' : 'post', action === 'suspend-user' ? post.author : post._id, { action, post: post._id });
  flash(req, 'success', 'The action was sent to the administrator for approval.');
  res.redirect(`/posts/${req.params.id}`);
};

exports.admin = async (req, res) => {
  const [users, communities, posts, openReports, pendingActions, moderators, auditLogs, siteSettings] = await Promise.all([
    User.find().sort({ createdAt: -1 }).limit(80).select('name email role moderatorId isVerified createdAt suspendedUntil suspensionReason postingRestrictedUntil postingRestrictionReason warnings').lean(),
    Community.find().sort({ createdAt: -1 }).limit(60).select('name slug description guidelines category isPrivate requireApproval bannedWords owner membersCount members moderators pinnedPosts createdAt').populate('owner', 'name email').lean(),
    Post.find().sort({ moderationScore: -1, createdAt: -1 }).limit(40).select('body type status contentWarning author community createdAt likes commentsCount sharesCount moderationScore moderationStatus').populate('author', 'name email').populate('community', 'name').lean(),
    Report.find({ status: { $in: ['open', 'reviewing'] } }).sort({ createdAt: -1 }).limit(80).populate('reporter', 'name email').lean(),
    ModerationAction.find({ status: 'pending' }).sort({ createdAt: -1 }).limit(80).populate('moderator', 'name moderatorId').lean(),
    User.find({ role: 'moderator' }).select('name email moderatorId isVerified createdAt loginLockedUntil').sort({ createdAt: -1 }).lean(),
    AuditLog.find().sort({ createdAt: -1 }).limit(100).populate('actor', 'name email role moderatorId').lean(),
    SiteSetting.getSingleton()
  ]);
  const pinnedPostIds = new Set(communities.flatMap((community) => (community.pinnedPosts || []).map((id) => String(id))));
  res.render('pages/admin', { title: 'Admin console', pagePath: '/admin', noIndex: true, users, communities, posts, openReports, pendingActions, moderators, auditLogs, siteSettings, pinnedPostIds, stats: { users: await User.countDocuments(), communities: await Community.countDocuments(), posts: await Post.countDocuments(), reports: await Report.countDocuments() } });
};

exports.updateUser = async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.redirect('/admin#users');
  const isSelf = String(user._id) === String(req.roleUser._id);
  const changes = {};
  if (req.body.name?.trim()) changes.name = req.body.name.trim().slice(0, 80);
  if (req.body.email?.trim()) changes.email = req.body.email.trim().toLowerCase();
  if (!isSelf && ['user', 'moderator', 'admin'].includes(req.body.role) && req.body.role !== user.role) {
    changes.role = req.body.role;
    if (req.body.role === 'moderator' && !user.moderatorId) changes.moderatorId = `MOD-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    if (req.body.role !== 'moderator') changes.moderatorId = undefined;
  }
  changes.isVerified = req.body.isVerified === 'on';
  if (!isSelf) {
    if (req.body.suspend === 'on') {
      changes.suspendedUntil = new Date(Date.now() + SUSPENSION_MS);
      changes.suspensionReason = req.body.suspensionReason?.trim().slice(0, 500) || 'Suspended by admin.';
    } else if (req.body.suspend === 'off') {
      changes.suspendedUntil = null;
      changes.suspensionReason = '';
    }
    const restrictionDurations = { '24h': 24 * 60 * 60 * 1000, '72h': 3 * 24 * 60 * 60 * 1000, '7d': 7 * 24 * 60 * 60 * 1000 };
    if (restrictionDurations[req.body.postingRestriction]) {
      changes.postingRestrictedUntil = new Date(Date.now() + restrictionDurations[req.body.postingRestriction]);
      changes.postingRestrictionReason = req.body.postingRestrictionReason?.trim().slice(0, 500) || 'Restricted by admin.';
    } else if (req.body.postingRestriction === 'off') {
      changes.postingRestrictedUntil = null;
      changes.postingRestrictionReason = '';
    }
  }
  Object.assign(user, changes);
  await user.save();
  await audit(req, 'edit-user', 'user', user._id, { changes: Object.keys(changes) });
  flash(req, 'success', `Updated ${user.name}.`);
  res.redirect('/admin#users');
};

exports.deleteUser = async (req, res) => {
  if (String(req.params.id) === String(req.roleUser._id)) return res.redirect('/admin#users');
  const user = await User.findById(req.params.id);
  if (user?.role === 'admin') return res.redirect('/admin#users');
  if (user) {
    await Promise.all([User.deleteOne({ _id: user._id }), Post.deleteMany({ author: user._id })]);
    await audit(req, 'delete-user', 'user', user._id, { email: user.email });
  }
  flash(req, 'success', 'User removed.');
  res.redirect('/admin#users');
};

exports.updatePost = async (req, res) => {
  const post = await Post.findById(req.params.id);
  if (!post) return res.redirect('/admin#posts');
  if (req.body.body?.trim()) post.body = req.body.body.trim().slice(0, 4000);
  if (['draft', 'scheduled', 'published', 'pending', 'rejected'].includes(req.body.status)) post.status = req.body.status;
  if (['unreviewed', 'good', 'needs-review', 'reported'].includes(req.body.moderationStatus)) post.moderationStatus = req.body.moderationStatus;
  post.contentWarning = req.body.contentWarning?.trim().slice(0, 120) || '';
  await post.save();
  if (req.body.pinToCommunity === 'on' && post.community) {
    await Community.findByIdAndUpdate(post.community, { $addToSet: { pinnedPosts: post._id } });
  } else if (req.body.pinToCommunity === 'off' && post.community) {
    await Community.findByIdAndUpdate(post.community, { $pull: { pinnedPosts: post._id } });
  }
  await audit(req, 'edit-post', 'post', post._id, { status: post.status });
  flash(req, 'success', 'Post updated.');
  res.redirect('/admin#posts');
};

exports.deletePost = async (req, res) => {
  const post = await Post.findByIdAndDelete(req.params.id);
  if (post) await audit(req, 'delete-post', 'post', post._id, { reason: 'admin action' });
  flash(req, 'success', 'Post deleted.');
  res.redirect('/admin#posts');
};

exports.updateCommunity = async (req, res) => {
  const community = await Community.findById(req.params.id);
  if (!community) return res.redirect('/admin#communities');
  if (req.body.name?.trim()) community.name = req.body.name.trim().slice(0, 100);
  if (req.body.description?.trim()) community.description = req.body.description.trim().slice(0, 280);
  community.guidelines = req.body.guidelines?.trim().slice(0, 4000) || '';
  if (req.body.category?.trim()) community.category = req.body.category.trim().toLowerCase().slice(0, 40);
  community.isPrivate = req.body.isPrivate === 'on';
  community.requireApproval = req.body.requireApproval === 'on';
  community.bannedWords = (req.body.bannedWords || '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean).slice(0, 100);
  await community.save();
  await audit(req, 'edit-community', 'community', community._id, { name: community.name });
  flash(req, 'success', 'Community updated.');
  res.redirect('/admin#communities');
};

exports.deleteCommunity = async (req, res) => {
  const community = await Community.findByIdAndDelete(req.params.id);
  if (community) {
    await Post.deleteMany({ community: community._id });
    await audit(req, 'delete-community', 'community', community._id, { name: community.name });
  }
  flash(req, 'success', 'Community deleted.');
  res.redirect('/admin#communities');
};

exports.updateSiteSettings = async (req, res) => {
  const settings = await SiteSetting.getSingleton();
  settings.siteName = req.body.siteName?.trim().slice(0, 60) || settings.siteName;
  settings.tagline = req.body.tagline?.trim().slice(0, 160) || '';
  settings.registrationOpen = req.body.registrationOpen === 'on';
  settings.maintenanceMode = req.body.maintenanceMode === 'on';
  settings.maintenanceMessage = req.body.maintenanceMessage?.trim().slice(0, 300) || '';
  settings.announcement = req.body.announcement?.trim().slice(0, 300) || '';
  settings.postApprovalDefault = req.body.postApprovalDefault === 'on';
  settings.updatedBy = req.roleUser._id;
  await settings.save();
  await audit(req, 'edit-site-settings', 'site', settings._id, {});
  flash(req, 'success', 'Site settings saved.');
  res.redirect('/admin#settings');
};

exports.createModerator = async (req, res) => {
  const { name, email, password } = req.body;
  if (!name?.trim() || !email?.trim() || !password || password.length < 8) {
    flash(req, 'error', 'Add a name, email, and moderator password of at least 8 characters.');
    return res.redirect('/admin');
  }
  const normalizedEmail = email.toLowerCase().trim();
  if (await User.exists({ email: normalizedEmail })) {
    flash(req, 'error', 'That email is already in use.');
    return res.redirect('/admin');
  }
  const moderator = await User.create({ name: name.trim(), email: normalizedEmail, password: await bcrypt.hash(password, 12), role: 'moderator', moderatorId: `MOD-${crypto.randomBytes(5).toString('hex').toUpperCase()}`, isVerified: true });
  await audit(req, 'create-moderator', 'user', moderator._id, { moderatorId: moderator.moderatorId });
  flash(req, 'success', `Moderator created. Their identifier is ${moderator.moderatorId}.`);
  res.redirect('/admin');
};

exports.deleteModerator = async (req, res) => {
  const moderator = await User.findOne({ _id: req.params.id, role: 'moderator' });
  if (moderator) {
    moderator.role = 'user';
    moderator.moderatorId = undefined;
    await moderator.save();
    await audit(req, 'remove-moderator', 'user', moderator._id);
  }
  flash(req, 'success', 'Moderator access removed.');
  res.redirect('/admin');
};

exports.resolveReport = async (req, res) => {
  const report = await Report.findById(req.params.id);
  if (!report) return res.redirect('/admin#reports');
  report.status = ['resolved', 'dismissed'].includes(req.body.status) ? req.body.status : 'reviewing';
  report.resolution = req.body.resolution?.trim().slice(0, 1000) || '';
  report.reviewedBy = req.roleUser._id;
  report.reviewedAt = new Date();
  await report.save();
  await audit(req, 'resolve-report', report.targetType, report.target, { status: report.status, reportId: report._id });
  res.redirect('/admin#reports');
};

async function applyApprovedAction(req, action) {
  const payload = action.payload || {};
  if (action.action === 'delete-post') await Post.deleteOne({ _id: action.target });
  if (action.action === 'edit-post' && payload.body?.trim()) {
    await Post.findByIdAndUpdate(action.target, { body: payload.body.trim().slice(0, 4000) });
  }
  if (action.action === 'suspend-user') {
    await User.findByIdAndUpdate(action.target, { suspendedUntil: new Date(Date.now() + SUSPENSION_MS), suspensionReason: action.reason });
  }
  if (action.action === 'unsuspend-user') {
    await User.findByIdAndUpdate(action.target, { suspendedUntil: null, suspensionReason: '' });
  }
  if (action.action === 'warn-user') {
    await User.findByIdAndUpdate(action.target, { $push: { warnings: { reason: action.reason, issuedBy: action.moderator } } });
  }
  if (action.action === 'edit-community') {
    const update = {};
    if (payload.description?.trim()) update.description = payload.description.trim().slice(0, 280);
    if (payload.guidelines !== undefined) update.guidelines = payload.guidelines.trim().slice(0, 4000);
    if (payload.bannedWords !== undefined) {
      update.bannedWords = payload.bannedWords.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean).slice(0, 100);
    }
    if (Object.keys(update).length) await Community.findByIdAndUpdate(action.target, update);
  }
  if (action.action === 'resolve-report') await Report.findByIdAndUpdate(action.target, { status: 'resolved', reviewedBy: req.roleUser._id, reviewedAt: new Date(), resolution: action.reason });
  if (['rate-good-post', 'rate-bad-post'].includes(action.action)) {
    const scoreChange = action.action === 'rate-good-post' ? 1 : -1;
    await Post.findByIdAndUpdate(action.target, { $inc: { moderationScore: scoreChange }, $set: { moderationStatus: scoreChange > 0 ? 'good' : 'needs-review' } });
  }
  if (action.action === 'report-post') {
    await Report.updateOne({ reporter: action.moderator, targetType: 'post', target: action.target }, { $setOnInsert: { reporter: action.moderator, targetType: 'post', target: action.target, reason: action.reason } }, { upsert: true });
    await Post.findByIdAndUpdate(action.target, { $set: { moderationStatus: 'reported' } });
  }
}

exports.reviewAction = async (req, res) => {
  const action = await ModerationAction.findOne({ _id: req.params.id, status: 'pending' });
  if (!action) return res.redirect('/admin#queue');
  const approved = req.body.decision === 'approve';
  if (approved) await applyApprovedAction(req, action);
  action.status = approved ? 'approved' : 'rejected';
  action.reviewedBy = req.roleUser._id;
  action.reviewedAt = new Date();
  action.reviewNote = req.body.note?.trim().slice(0, 500) || '';
  await action.save();
  await audit(req, `${approved ? 'approve' : 'reject'}-moderation-action`, action.targetType, action.target, { action: action.action, moderator: action.moderator });
  flash(req, 'success', approved ? 'Action approved and applied.' : 'Action rejected.');
  res.redirect('/admin#queue');
};

exports.moderator = async (req, res) => {
  const [reports, actions, communities, moderationFeed] = await Promise.all([
    Report.find({ status: { $in: ['open', 'reviewing'] } }).sort({ createdAt: -1 }).limit(60).select('targetType target reason evidenceUrl status createdAt').lean(),
    ModerationAction.find({ moderator: req.roleUser._id }).sort({ createdAt: -1 }).limit(60).select('action targetType target reason status createdAt reviewNote').lean(),
    Community.find().sort({ membersCount: -1 }).limit(60).select('name slug description guidelines category membersCount requireApproval bannedWords createdAt').lean(),
    Post.find({ status: 'published', author: { $ne: req.roleUser._id } }).sort({ moderationScore: -1, createdAt: -1 }).limit(50).select('body type author community createdAt moderationScore moderationStatus').populate('author', 'name profilePicture').populate('community', 'name slug').lean()
  ]);
  res.render('pages/moderator', { title: 'Moderator console', pagePath: '/moderator', noIndex: true, reports, actions, communities, moderationFeed, moderator: req.roleUser });
};

exports.submitAction = async (req, res) => {
  const allowed = ['delete-post', 'edit-post', 'suspend-user', 'unsuspend-user', 'warn-user', 'edit-community', 'resolve-report', 'rate-good-post', 'rate-bad-post', 'report-post'];
  if (!allowed.includes(req.body.action) || !req.body.target || !req.body.reason?.trim()) return res.redirect('/moderator');
  const postActions = ['delete-post', 'edit-post', 'rate-good-post', 'rate-bad-post', 'report-post'];
  const userActions = ['suspend-user', 'unsuspend-user', 'warn-user'];
  const targetType = postActions.includes(req.body.action) ? 'post' : userActions.includes(req.body.action) ? 'user' : req.body.action === 'edit-community' ? 'community' : 'report';
  if (postActions.includes(req.body.action)) {
    const post = await Post.findOne({ _id: req.body.target, author: { $ne: req.roleUser._id } }).select('_id').lean();
    if (!post) {
      flash(req, 'error', 'Moderators cannot review or influence their own posts.');
      return res.redirect('/moderator');
    }
  }
  let payload;
  if (req.body.action === 'edit-post' && req.body.payload?.body?.trim()) payload = { body: req.body.payload.body.trim().slice(0, 4000) };
  if (req.body.action === 'edit-community') {
    payload = {
      description: req.body.payload?.description?.trim().slice(0, 280) || '',
      guidelines: req.body.payload?.guidelines?.trim().slice(0, 4000) || '',
      bannedWords: req.body.payload?.bannedWords?.trim().slice(0, 1000) || ''
    };
  }
  await ModerationAction.create({ moderator: req.roleUser._id, action: req.body.action, targetType, target: req.body.target, reason: req.body.reason.trim(), payload });
  await audit(req, 'submit-moderation-action', targetType, req.body.target, { action: req.body.action });
  flash(req, 'success', 'The action was sent to the administrator for approval.');
  res.redirect('/moderator');
};
