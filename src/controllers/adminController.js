const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Post = require('../models/Post');
const Community = require('../models/Community');
const Report = require('../models/Report');
const AuditLog = require('../models/AuditLog');
const ModerationAction = require('../models/ModerationAction');

const flash = (req, type, message) => { req.session.flash = { type, message }; };
const audit = (req, action, targetType, target, details = {}) => AuditLog.create({ actor: req.roleUser._id, action, targetType, target, details, ipAddress: req.ip, userAgent: req.get('user-agent') });
const panelRoles = { admin: ['admin'], moderator: ['admin', 'moderator'] };

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

exports.admin = async (req, res) => {
  const [users, communities, posts, openReports, pendingActions, moderators, auditLogs] = await Promise.all([
    User.find().sort({ createdAt: -1 }).limit(80).select('name email role moderatorId isVerified createdAt loginLockedUntil').lean(),
    Community.find().sort({ createdAt: -1 }).limit(60).select('name slug owner membersCount members moderators requireApproval createdAt').populate('owner', 'name email').lean(),
    Post.find().sort({ moderationScore: -1, createdAt: -1 }).limit(40).select('body type status author community createdAt likes commentsCount sharesCount moderationScore moderationStatus').populate('author', 'name email').populate('community', 'name').lean(),
    Report.find({ status: { $in: ['open', 'reviewing'] } }).sort({ createdAt: -1 }).limit(80).populate('reporter', 'name email').lean(),
    ModerationAction.find({ status: 'pending' }).sort({ createdAt: -1 }).limit(80).populate('moderator', 'name moderatorId').lean(),
    User.find({ role: 'moderator' }).select('name email moderatorId isVerified createdAt loginLockedUntil').sort({ createdAt: -1 }).lean(),
    AuditLog.find().sort({ createdAt: -1 }).limit(100).populate('actor', 'name email role moderatorId').lean()
  ]);
  res.render('pages/admin', { title: 'Admin console', pagePath: '/admin', noIndex: true, users, communities, posts, openReports, pendingActions, moderators, auditLogs, stats: { users: await User.countDocuments(), communities: await Community.countDocuments(), posts: await Post.countDocuments(), reports: await Report.countDocuments() } });
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
  if (!report) return res.redirect('/admin');
  report.status = ['resolved', 'dismissed'].includes(req.body.status) ? req.body.status : 'reviewing';
  report.resolution = req.body.resolution?.trim().slice(0, 1000) || '';
  report.reviewedBy = req.roleUser._id;
  report.reviewedAt = new Date();
  await report.save();
  await audit(req, 'resolve-report', report.targetType, report.target, { status: report.status, reportId: report._id });
  res.redirect('/admin');
};

exports.reviewAction = async (req, res) => {
  const action = await ModerationAction.findOne({ _id: req.params.id, status: 'pending' });
  if (!action) return res.redirect('/admin');
  const approved = req.body.decision === 'approve';
  if (approved) {
    if (action.action === 'delete-post') await Post.deleteOne({ _id: action.target });
    if (action.action === 'suspend-user') await User.findByIdAndUpdate(action.target, { loginLockedUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) });
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
  action.status = approved ? 'approved' : 'rejected';
  action.reviewedBy = req.roleUser._id;
  action.reviewedAt = new Date();
  action.reviewNote = req.body.note?.trim().slice(0, 500) || '';
  await action.save();
  await audit(req, `${approved ? 'approve' : 'reject'}-moderation-action`, action.targetType, action.target, { action: action.action, moderator: action.moderator });
  res.redirect('/admin');
};

exports.deletePost = async (req, res) => {
  const post = await Post.findByIdAndDelete(req.params.id);
  if (post) await audit(req, 'delete-post', 'post', post._id, { reason: 'admin action' });
  res.redirect('/admin');
};

exports.deleteUser = async (req, res) => {
  if (String(req.params.id) === String(req.roleUser._id)) return res.redirect('/admin');
  const user = await User.findById(req.params.id);
  if (user?.role === 'admin') return res.redirect('/admin');
  if (user) {
    await Promise.all([User.deleteOne({ _id: user._id }), Post.deleteMany({ author: user._id })]);
    await audit(req, 'delete-user', 'user', user._id, { email: user.email });
  }
  res.redirect('/admin');
};

exports.moderator = async (req, res) => {
  const [reports, actions, communities, moderationFeed] = await Promise.all([
    Report.find({ status: { $in: ['open', 'reviewing'] } }).sort({ createdAt: -1 }).limit(60).select('targetType target reason status createdAt').lean(),
    ModerationAction.find({ moderator: req.roleUser._id }).sort({ createdAt: -1 }).limit(60).select('action targetType target reason status createdAt reviewNote').lean(),
    Community.find().sort({ membersCount: -1 }).limit(60).select('name slug description category membersCount requireApproval createdAt').lean(),
    Post.find({ status: 'published', author: { $ne: req.roleUser._id } }).sort({ moderationScore: -1, createdAt: -1 }).limit(50).select('body type author community createdAt moderationScore moderationStatus').populate('author', 'name profilePicture').populate('community', 'name slug').lean()
  ]);
  res.render('pages/moderator', { title: 'Moderator console', pagePath: '/moderator', noIndex: true, reports, actions, communities, moderationFeed, moderator: req.roleUser });
};

exports.submitAction = async (req, res) => {
  const allowed = ['delete-post', 'suspend-user', 'resolve-report', 'rate-good-post', 'rate-bad-post', 'report-post'];
  if (!allowed.includes(req.body.action) || !req.body.target || !req.body.reason?.trim()) return res.redirect('/moderator');
  const targetType = ['delete-post', 'rate-good-post', 'rate-bad-post', 'report-post'].includes(req.body.action) ? 'post' : req.body.action === 'suspend-user' ? 'user' : 'report';
  if (['delete-post', 'rate-good-post', 'rate-bad-post', 'report-post'].includes(req.body.action)) {
    const post = await Post.findOne({ _id: req.body.target, author: { $ne: req.roleUser._id } }).select('_id').lean();
    if (!post) {
      flash(req, 'error', 'Moderators cannot review or influence their own posts.');
      return res.redirect('/moderator');
    }
  }
  await ModerationAction.create({ moderator: req.roleUser._id, action: req.body.action, targetType, target: req.body.target, reason: req.body.reason.trim() });
  await audit(req, 'submit-moderation-action', targetType, req.body.target, { action: req.body.action });
  flash(req, 'success', 'The action was sent to the administrator for approval.');
  res.redirect('/moderator');
};
