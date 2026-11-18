const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { hashPassword } = require('../utils/passwords');
const User = require('../models/User');
const Post = require('../models/Post');
const Community = require('../models/Community');
const Report = require('../models/Report');
const AuditLog = require('../models/AuditLog');
const WavesLedgerEntry = require('../models/WavesLedgerEntry');
const WavesAbuseSignal = require('../models/WavesAbuseSignal');
const { clearAllFeedCaches } = require('../services/feedService');
const ModerationAction = require('../models/ModerationAction');
const SiteSetting = require('../models/SiteSetting');
const { reengagementReport } = require('../services/reengagement');
const MaintenanceRun = require('../models/MaintenanceRun');
const Appeal = require('../models/Appeal');
const { logEvent } = require('../services/accountHistory');
const { getSiteConfig, clearSiteConfigCache, getPostReviewThreshold } = require('../services/siteConfig');
const { runMaintenance, TASK_LABELS } = require('../services/maintenance');
const { getMongoStorage, formatStorage } = require('../services/mongoStorage');
const { adjustWaves, getReciprocalRewardSignals } = require('../services/waves');
const { COMMUNITY_CATEGORIES, normalizeCommunityCategory } = require('../utils/communityCategories');
const { removeUserFromCommunities } = require('../services/communityMembership');
const { uploadBuffer, mediaUrl, deleteFile } = require('../services/storageCluster');
const logger = require('../services/logger');

const flash = (req, type, message) => { req.session.flash = { type, message }; };
const audit = (req, action, targetType, target, details = {}) => AuditLog.create({ actor: req.roleUser._id, action, targetType, target, details, ipAddress: req.ip, userAgent: req.get('user-agent') });
const panelRoles = { admin: ['admin'], moderator: ['admin', 'moderator'] };
const postModerationActions = ['delete-post', 'suspend-user', 'rate-good-post', 'rate-bad-post', 'report-post', 'flag-spam'];
// Moderator risk tiers. Low-risk actions take effect immediately (an admin can still
// revert them, or give spam flags a final look). Everything else waits for admin approval.
const LOW_RISK_ACTIONS = new Set(['rate-good-post', 'rate-bad-post', 'edit-post', 'flag-spam', 'report-post']);
const REVERTIBLE_ACTIONS = new Set(['rate-good-post', 'rate-bad-post', 'edit-post']);
const DAY_MS = 24 * 60 * 60 * 1000;
const SUSPENSION_MS = 365 * DAY_MS; // fallback used only where a site-config lookup isn't already in hand


// Applies a moderator's low-risk action right away and records it for admin oversight.
async function applyLowRiskAction(req, { action, post, reason, payload = {} }) {
  const record = { moderator: req.roleUser._id, action, targetType: 'post', target: post._id, reason, autoApplied: true };
  if (action === 'rate-good-post') {
    await Post.findByIdAndUpdate(post._id, { $inc: { moderationScore: 1 }, $set: { moderationStatus: 'good' } });
    record.status = 'approved';
  } else if (action === 'rate-bad-post') {
    await Post.findByIdAndUpdate(post._id, { $inc: { moderationScore: -1 }, $set: { moderationStatus: 'needs-review' } });
    record.status = 'approved';
  } else if (action === 'report-post') {
    await Report.updateOne({ reporter: req.roleUser._id, targetType: 'post', target: post._id }, { $setOnInsert: { reporter: req.roleUser._id, targetType: 'post', target: post._id, reason } }, { upsert: true });
    await Post.findByIdAndUpdate(post._id, { $set: { moderationStatus: 'reported' } });
    record.status = 'approved';
  } else if (action === 'edit-post') {
    const body = String(payload.body || '').trim().slice(0, 4000);
    if (!body) return null;
    const current = await Post.findById(post._id).select('body').lean();
    if (!current) return null;
    await Post.findByIdAndUpdate(post._id, { body });
    record.status = 'approved';
    record.payload = { body, previousBody: current.body };
  } else if (action === 'flag-spam') {
    const current = await Post.findById(post._id).select('status').lean();
    if (!current) return null;
    // Hidden from everyone but the author immediately; the admin makes the final call.
    await Post.findByIdAndUpdate(post._id, { $set: { status: 'rejected', moderationStatus: 'reported' } });
    clearAllFeedCaches();
    record.status = 'pending';
    record.payload = { previousStatus: current.status };
  } else return null;
  if (record.status === 'approved') { record.reviewedAt = new Date(); record.reviewNote = 'Auto-approved (low risk).'; }
  const created = await ModerationAction.create(record);
  await audit(req, `auto-${action}`, 'post', post._id, { action, moderationActionId: created._id });
  return created;
}

const LOW_RISK_MESSAGES = {
  'rate-good-post': 'Marked as a good post.',
  'rate-bad-post': 'Marked for review.',
  'report-post': 'Post reported. It now shows in the reports queue.',
  'edit-post': 'Your edit was applied. An admin can review or revert it.',
  'flag-spam': 'The post was hidden from public view and sent to the administrator for a final look.'
};

async function applyPostModerationAction(req, action, post, reason) {
  if (action === 'delete-post') await Post.deleteOne({ _id: post._id });
  if (action === 'suspend-user') {
    await User.findByIdAndUpdate(post.author?._id || post.author, { suspendedUntil: new Date(Date.now() + SUSPENSION_MS), suspensionReason: reason });
    logEvent(post.author?._id || post.author, 'suspended', reason);
  }
  if (['rate-good-post', 'rate-bad-post'].includes(action)) {
    const scoreChange = action === 'rate-good-post' ? 1 : -1;
    await Post.findByIdAndUpdate(post._id, { $inc: { moderationScore: scoreChange }, $set: { moderationStatus: scoreChange > 0 ? 'good' : 'needs-review' } });
  }
  if (action === 'flag-spam') await Post.findByIdAndUpdate(post._id, { $set: { status: 'rejected', moderationStatus: 'reported' } });
  if (action === 'report-post') {
    await Report.updateOne({ reporter: req.roleUser._id, targetType: 'post', target: post._id }, { $setOnInsert: { reporter: req.roleUser._id, targetType: 'post', target: post._id, reason } }, { upsert: true });
    await Post.findByIdAndUpdate(post._id, { $set: { moderationStatus: 'reported' } });
  }
}

exports.panelAccessPage = async (req, res) => {
  const panel = req.params.panel;
  if (!panelRoles[panel]) return res.status(404).render('pages/not-found', { title: 'Page not found' });
  // Only admins/moderators should ever see the panel login itself, not just
  // be blocked when they try to submit it - a regular user landing on this
  // page (by guessing the URL, an old bookmark, etc.) should get the same
  // "not found" any other disallowed page gives them.
  const user = await User.findById(req.session.user.id).select('role');
  if (!user || !panelRoles[panel].includes(user.role)) return res.status(403).render('pages/not-found', { title: 'Access denied' });
  res.render('pages/panel-access', { title: `${panel === 'admin' ? 'Admin' : 'Moderator'} panel access`, panel, panelLabel: panel === 'admin' ? 'admin' : 'moderator' });
};

exports.panelAccess = async (req, res) => {
  const panel = req.params.panel;
  if (!panelRoles[panel]) return res.status(404).render('pages/not-found', { title: 'Page not found' });
  const user = await User.findById(req.session.user.id).select('password role passwordSet');
  if (!user || !panelRoles[panel].includes(user.role)) return res.status(403).render('pages/not-found', { title: 'Access denied' });
  if (user.passwordSet === false) {
    flash(req, 'error', 'Set your panel password first - use the prompt on any page.');
    return res.redirect('/dashboard');
  }
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
  if (LOW_RISK_ACTIONS.has(action)) {
    const done = await applyLowRiskAction(req, { action, post: { _id: post._id }, reason });
    if (done) {
      flash(req, 'success', LOW_RISK_MESSAGES[action]);
      return res.redirect(`/posts/${req.params.id}`);
    }
  }
  await ModerationAction.create({ moderator: req.roleUser._id, action, targetType: action === 'suspend-user' ? 'user' : 'post', target: action === 'suspend-user' ? post.author : post._id, reason });
  await audit(req, 'submit-moderation-action', action === 'suspend-user' ? 'user' : 'post', action === 'suspend-user' ? post.author : post._id, { action, post: post._id });
  flash(req, 'success', 'The action was sent to the administrator for approval.');
  res.redirect(`/posts/${req.params.id}`);
};

// The approval queue used to show only a raw target ObjectId, which meant
// an admin had to go dig up the report/post/user themselves before they
// could judge a pending action. Attaching a short snippet of what's
// actually being acted on makes "approve or reject" a real decision
// instead of a guess.
async function attachActionContext(actions) {
  const reportIds = actions.filter((a) => a.targetType === 'report').map((a) => a.target);
  const postIds = actions.filter((a) => a.targetType === 'post').map((a) => a.target);
  const userIds = actions.filter((a) => a.targetType === 'user').map((a) => a.target);
  const [reports, posts, users] = await Promise.all([
    reportIds.length ? Report.find({ _id: { $in: reportIds } }).select('targetType target reason status').lean() : [],
    postIds.length ? Post.find({ _id: { $in: postIds } }).select('body').populate('author', 'name').lean() : [],
    userIds.length ? User.find({ _id: { $in: userIds } }).select('name email').lean() : []
  ]);
  const reportMap = new Map(reports.map((r) => [String(r._id), r]));
  const postMap = new Map(posts.map((p) => [String(p._id), p]));
  const userMap = new Map(users.map((u) => [String(u._id), u]));
  actions.forEach((a) => {
    if (a.targetType === 'report') a.reportContext = reportMap.get(String(a.target));
    if (a.targetType === 'post') a.postContext = postMap.get(String(a.target));
    if (a.targetType === 'user') a.userContext = userMap.get(String(a.target));
  });
  return actions;
}

exports.admin = async (req, res) => {
  const [users, communities, posts, openReports, pendingActions, pendingAppeals, moderators, auditLogs, maintenanceRuns, siteSettings, mongoStorage, suspiciousRewardPairs, wavesEconomy, heldWavesUsers, suspiciousWavesTransfers] = await Promise.all([
    User.find().sort({ createdAt: -1 }).limit(80).select('name email role moderatorId isVerified createdAt suspendedUntil suspensionReason postingRestrictedUntil postingRestrictionReason wavesSuspendedUntil wavesSuspensionReason wavesBalance warnings').lean(),
    Community.find().sort({ createdAt: -1 }).limit(60).select('name slug description guidelines category isPrivate requireApproval bannedWords owner membersCount members moderators pinnedPosts createdAt').populate('owner', 'name email').lean(),
    Post.find().sort({ moderationScore: -1, createdAt: -1 }).limit(40).select('body type status contentWarning author community createdAt likes commentsCount sharesCount moderationScore moderationStatus').populate('author', 'name email').populate('community', 'name').lean(),
    Report.find({ status: { $in: ['open', 'reviewing'] } }).sort({ createdAt: -1 }).limit(80).populate('reporter', 'name email').lean(),
    ModerationAction.find({ status: 'pending' }).sort({ createdAt: -1 }).limit(80).populate('moderator', 'name moderatorId').lean(),
    Appeal.find({ status: 'pending' }).sort({ createdAt: -1 }).limit(80).populate('user', 'name email').lean(),
    User.find({ role: 'moderator' }).select('name email moderatorId isVerified createdAt loginLockedUntil').sort({ createdAt: -1 }).lean(),
    AuditLog.find().sort({ createdAt: -1 }).limit(100).populate('actor', 'name email role moderatorId').lean(),
    MaintenanceRun.find().sort({ createdAt: -1 }).limit(30).populate('triggeredBy', 'name').lean(),
    SiteSetting.getSingleton(),
    getMongoStorage(),
    getReciprocalRewardSignals(),
    WavesLedgerEntry.aggregate([
      { $match: { status: 'posted', createdAt: { $gte: new Date(Date.now() - 30 * DAY_MS) } } },
      { $group: { _id: '$type', entries: { $sum: 1 }, netWaves: { $sum: '$amount' } } }
    ]),
    User.find({ wavesSuspendedUntil: { $gt: new Date() } }).sort({ wavesSuspendedUntil: 1 }).limit(30).select('name email wavesSuspendedUntil wavesSuspensionReason wavesBalance').lean(),
    WavesAbuseSignal.find({ status: 'open' }).sort({ lastSeenAt: -1 }).limit(100).populate('sender', 'name email').populate('recipient', 'name email').lean()
  ]);
  const pinnedPostIds = new Set(communities.flatMap((community) => (community.pinnedPosts || []).map((id) => String(id))));
  const autoApplied = await ModerationAction.find({ autoApplied: true, status: 'approved', revertedAt: null, action: { $in: [...REVERTIBLE_ACTIONS] } }).sort({ createdAt: -1 }).limit(30).populate('moderator', 'name moderatorId').lean();
  await attachActionContext([...pendingActions, ...autoApplied]);
  res.locals.surveys = await require('../services/surveys').adminSurveys();
  const partnershipData = await require('./partnershipController').adminData();
  const reengagement = await reengagementReport().catch(() => null);
  res.render('pages/admin', { reengagement, title: 'Admin console', pagePath: '/admin', noIndex: true, autoApplied, ...partnershipData, users, communities, posts, pinnedPostIds, openReports, pendingActions, pendingAppeals, moderators, auditLogs, maintenanceRuns, maintenanceTaskLabels: TASK_LABELS, communityCategories: COMMUNITY_CATEGORIES, siteSettings, mongoStorage, formatStorage, suspiciousRewardPairs, wavesEconomy, heldWavesUsers, suspiciousWavesTransfers, stats: { users: await User.countDocuments(), communities: await Community.countDocuments(), posts: await Post.countDocuments(), reports: await Report.countDocuments() } });
};

exports.runMaintenance = async (req, res) => {
  const task = String(req.body.task || '');
  if (task !== 'all' && !Object.hasOwn(TASK_LABELS, task)) {
    flash(req, 'error', 'Choose a valid maintenance process.');
    return res.redirect('/admin#maintenance');
  }
  try {
    const run = await runMaintenance({ task, triggeredBy: req.roleUser._id });
    await audit(req, 'run-maintenance-cleanup', 'maintenance', run._id, { task, status: run.status });
    flash(req, run.status === 'success' ? 'success' : 'error', run.status === 'success'
      ? `Maintenance process completed: ${TASK_LABELS[task] || 'all cleanup processes'}.`
      : `Maintenance process completed with errors. Review the run log for details.`);
  } catch (error) {
    logger.error('Running admin maintenance failed', error);
    flash(req, 'error', 'The maintenance process could not be completed. Check the server logs.');
  }
  res.redirect('/admin#maintenance');
};

// Resolving an appeal lifts (or upholds) a moderation action on a user's
// account, so it carries the same weight as a report resolution - moderators
// can handle it same as admins, not just admins. req.roleUser.role decides
// where to send them back to afterwards.
exports.resolveAppeal = async (req, res) => {
  const appeal = await Appeal.findById(req.params.id);
  const backTo = req.roleUser.role === 'admin' ? '/admin#appeals' : '/moderator#appeals';
  if (!appeal || appeal.status !== 'pending') {
    flash(req, 'error', 'That appeal is no longer pending.');
    return res.redirect(backTo);
  }
  const approve = req.body.decision === 'approve';
  appeal.reviewNote = req.body.note?.trim().slice(0, 500) || '';
  if (approve) {
    if (appeal.actionType === 'suspension') await User.findByIdAndUpdate(appeal.user, { suspendedUntil: null, suspensionReason: '' });
    else if (appeal.actionType === 'posting-restriction') await User.findByIdAndUpdate(appeal.user, { postingRestrictedUntil: null, postingRestrictionReason: '' });
    else if (appeal.actionType === 'warning') await User.findByIdAndUpdate(appeal.user, { $pull: { warnings: { _id: appeal.warningId } } });
  }
  appeal.status = approve ? 'approved' : 'denied';
  appeal.reviewedBy = req.roleUser._id;
  appeal.reviewedAt = new Date();
  await appeal.save();
  logEvent(appeal.user, approve ? 'appeal-approved' : 'appeal-denied', appeal.reviewNote);
  await audit(req, approve ? 'approve-appeal' : 'deny-appeal', 'user', appeal.user, { actionType: appeal.actionType });
  flash(req, 'success', `Appeal ${approve ? 'approved' : 'denied'}.`);
  res.redirect(backTo);
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
    // A custom end date always wins when the admin sets one (any value in
    // the date field, whether or not "Suspend" was also toggled). Otherwise
    // "Suspend" falls back to the site's configured default length.
    const customUntil = req.body.suspendUntil ? new Date(req.body.suspendUntil) : null;
    if (customUntil && !Number.isNaN(customUntil.getTime())) {
      changes.suspendedUntil = customUntil;
      changes.suspensionReason = req.body.suspensionReason?.trim().slice(0, 500) || 'Suspended by admin.';
    } else if (req.body.suspend === 'on') {
      const settings = await getSiteConfig();
      const days = settings.suspensionDefaultDays || 365;
      changes.suspendedUntil = new Date(Date.now() + days * DAY_MS);
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
    const wavesHoldDurations = { '24h': 24 * 60 * 60 * 1000, '72h': 3 * 24 * 60 * 60 * 1000, '7d': 7 * 24 * 60 * 60 * 1000 };
    if (wavesHoldDurations[req.body.wavesHold]) {
      if (!req.body.wavesSuspensionReason?.trim()) {
        flash(req, 'error', 'A reason is required for a Waves activity hold.');
        return res.redirect('/admin#users');
      }
      changes.wavesSuspendedUntil = new Date(Date.now() + wavesHoldDurations[req.body.wavesHold]);
      changes.wavesSuspensionReason = req.body.wavesSuspensionReason.trim().slice(0, 500);
    } else if (req.body.wavesHold === 'off') {
      changes.wavesSuspendedUntil = null;
      changes.wavesSuspensionReason = '';
    }
  }
  Object.assign(user, changes);
  await user.save();
  if (!isSelf && req.body.wavesAdjustment && req.body.wavesAdjustment !== '') {
    const amount = Number(req.body.wavesAdjustment);
    if (Number.isFinite(amount) && amount !== 0) {
      await adjustWaves({
        userId: user._id,
        delta: amount,
        reason: req.body.wavesAdjustmentReason?.trim() || 'Admin Waves adjustment',
        actorId: req.roleUser._id,
        referenceType: 'admin-user-adjustment'
      });
    }
  }
  if ('suspendedUntil' in changes) logEvent(user._id, changes.suspendedUntil ? 'suspended' : 'suspension-lifted', changes.suspensionReason);
  if ('postingRestrictedUntil' in changes) logEvent(user._id, changes.postingRestrictedUntil ? 'posting-restricted' : 'posting-restriction-lifted', changes.postingRestrictionReason);
  await audit(req, 'edit-user', 'user', user._id, {
    changes: Object.keys(changes),
    wavesHoldReason: changes.wavesSuspensionReason || undefined
  });
  flash(req, 'success', `Updated ${user.name}.`);
  res.redirect('/admin#users');
};

exports.deleteUser = async (req, res) => {
  if (String(req.params.id) === String(req.roleUser._id)) return res.redirect('/admin#users');
  const user = await User.findById(req.params.id);
  if (user?.role === 'admin') return res.redirect('/admin#users');
  if (user) {
    await Promise.all([
      User.deleteOne({ _id: user._id }),
      Post.deleteMany({ author: user._id }),
      removeUserFromCommunities(user._id)
    ]);
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

exports.reviewWavesAbuseSignal = async (req, res) => {
  const signal = await WavesAbuseSignal.findOne({ _id: req.params.id, status: 'open' });
  const reviewNote = String(req.body.reviewNote || '').trim().slice(0, 500);
  if (!signal) {
    flash(req, 'error', 'That Waves transfer signal is already reviewed or unavailable.');
    return res.redirect('/admin#overview');
  }
  if (!reviewNote) {
    flash(req, 'error', 'Add a review note before closing a Waves transfer signal.');
    return res.redirect('/admin#overview');
  }
  signal.status = 'reviewed';
  signal.reviewedBy = req.roleUser._id;
  signal.reviewedAt = new Date();
  signal.reviewNote = reviewNote;
  await signal.save();
  await audit(req, 'review-waves-transfer-signal', 'user', signal.sender, {
    recipient: signal.recipient,
    transferCount: signal.transferCount,
    totalWaves: signal.totalWaves,
    note: reviewNote
  });
  flash(req, 'success', 'Waves transfer signal reviewed.');
  return res.redirect('/admin#overview');
};

exports.updateCommunity = async (req, res) => {
  const community = await Community.findById(req.params.id);
  if (!community) return res.redirect('/admin#communities');
  if (req.body.name?.trim()) community.name = req.body.name.trim().slice(0, 100);
  if (req.body.description?.trim()) community.description = req.body.description.trim().slice(0, 280);
  community.guidelines = req.body.guidelines?.trim().slice(0, 4000) || '';
  if (req.body.category?.trim()) {
    const category = normalizeCommunityCategory(req.body.category, community.category);
    if (!category) {
      flash(req, 'error', 'Choose a category from the list.');
      return res.redirect('/admin#communities');
    }
    community.category = category;
  }
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
  settings.reengagementEnabled = req.body.reengagementEnabled === 'on';
  settings.welcomeEmailsEnabled = req.body.welcomeEmailsEnabled === 'on';
  const postWordLimit = Number(req.body.postWordLimit);
  if (Number.isFinite(postWordLimit) && postWordLimit >= 10) settings.postWordLimit = Math.min(2000, Math.round(postWordLimit));
  const articleWordLimit = Number(req.body.articleWordLimit);
  if (Number.isFinite(articleWordLimit) && articleWordLimit >= 50) settings.articleWordLimit = Math.min(20000, Math.round(articleWordLimit));
  const suspensionDefaultDays = Number(req.body.suspensionDefaultDays);
  if (Number.isFinite(suspensionDefaultDays) && suspensionDefaultDays >= 1) settings.suspensionDefaultDays = Math.min(3650, Math.round(suspensionDefaultDays));
  const postReviewThreshold = Number(req.body.postReviewThreshold);
  if (Number.isFinite(postReviewThreshold) && postReviewThreshold >= 1) settings.postReviewThreshold = Math.min(50, Math.round(postReviewThreshold));
  for (const [field, formName] of [
    ['wavesPostReward', 'post'],
    ['wavesCommentReward', 'comment'],
    ['wavesLikeReward', 'like'],
    ['wavesReceivedCommentReward', 'receivedComment'],
    ['wavesCommunityJoinReward', 'communityJoin'],
    ['wavesCommunityCreateReward', 'communityCreate'],
    ['wavesQuestCompletionReward', 'questCompletion'],
    ['wavesSurveyReward', 'survey']
  ]) {
    const minimum = Number(req.body[`waves${formName[0].toUpperCase()}${formName.slice(1)}RewardMinimum`]);
    const maximum = Number(req.body[`waves${formName[0].toUpperCase()}${formName.slice(1)}RewardMaximum`]);
    if (Number.isFinite(minimum) && Number.isFinite(maximum) && minimum >= 0 && maximum >= minimum) {
      settings[field] = { minimum: Math.min(10000, minimum), maximum: Math.min(10000, maximum) };
    }
  }
  const wavesDailyEarningLimit = Number(req.body.wavesDailyEarningLimit);
  if (Number.isFinite(wavesDailyEarningLimit) && wavesDailyEarningLimit >= 0) settings.wavesDailyEarningLimit = Math.min(100000, wavesDailyEarningLimit);
  const wavesMaxTransferAmount = Number(req.body.wavesMaxTransferAmount);
  if (Number.isFinite(wavesMaxTransferAmount) && wavesMaxTransferAmount >= 0) settings.wavesMaxTransferAmount = Math.min(1000000, wavesMaxTransferAmount);
  const wavesDailyTransferLimit = Number(req.body.wavesDailyTransferLimit);
  if (Number.isFinite(wavesDailyTransferLimit) && wavesDailyTransferLimit >= 0) settings.wavesDailyTransferLimit = Math.min(10000000, wavesDailyTransferLimit);
  settings.adFreeEnabled = req.body.adFreeEnabled === 'on';
  for (const field of ['adFreePrice1Month', 'adFreePrice4Months', 'adFreePrice12Months']) {
    const value = Number(req.body[field]);
    if (Number.isFinite(value) && value >= 1) settings[field] = Math.min(1000000, Math.round(value));
  }
  const wavesWelcomeBonus = Number(req.body.wavesWelcomeBonus);
  if (Number.isFinite(wavesWelcomeBonus) && wavesWelcomeBonus >= 0) settings.wavesWelcomeBonus = Math.min(10000, Math.round(wavesWelcomeBonus * 100) / 100);
  settings.communityPromotionEnabled = req.body.communityPromotionEnabled === 'on';
  const communityPromotionWavesCost = Number(req.body.communityPromotionWavesCost);
  if (Number.isFinite(communityPromotionWavesCost) && communityPromotionWavesCost >= 1) settings.communityPromotionWavesCost = Math.min(10000, Math.round(communityPromotionWavesCost));
  const communityPromotionDurationHours = Number(req.body.communityPromotionDurationHours);
  if (Number.isFinite(communityPromotionDurationHours) && communityPromotionDurationHours >= 1) settings.communityPromotionDurationHours = Math.min(168, Math.round(communityPromotionDurationHours));
  settings.updatedBy = req.roleUser._id;
  await settings.save();
  clearSiteConfigCache();
  await audit(req, 'edit-site-settings', 'site', settings._id, {});
  flash(req, 'success', 'Site settings saved.');
  res.redirect('/admin#settings');
};

function ambassadorPhotoFile(url) {
  const match = /^\/media\/(\d+)\/([a-f\d]{24})$/i.exec(String(url || ''));
  return match ? { cluster: Number(match[1]), id: match[2] } : null;
}

async function removeAmbassadorPhoto(url) {
  const file = ambassadorPhotoFile(url);
  if (!file) return;
  try {
    await deleteFile(file.cluster, file.id);
  } catch (error) {
    logger.warn('Brand ambassador photo could not be deleted', { error });
  }
}

exports.saveBrandAmbassador = async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 100);
  const role = String(req.body.role || '').trim().slice(0, 100);
  const bio = String(req.body.bio || '').trim().slice(0, 2000);
  const orderValue = Number.parseInt(req.body.displayOrder, 10);
  const displayOrder = Number.isFinite(orderValue) ? Math.min(9999, Math.max(0, orderValue)) : 100;
  if (name.length < 2) {
    flash(req, 'error', 'Add a name with at least 2 characters.');
    return res.redirect('/admin#brand-ambassadors');
  }

  const settings = await SiteSetting.getSingleton();
  const ambassador = req.params.id ? settings.brandAmbassadors.id(req.params.id) : null;
  if (req.params.id && !ambassador) {
    flash(req, 'error', 'That brand ambassador could not be found.');
    return res.redirect('/admin#brand-ambassadors');
  }
  if (!req.file && !ambassador?.photoUrl) {
    flash(req, 'error', 'Add a photo before saving this ambassador.');
    return res.redirect('/admin#brand-ambassadors');
  }

  const previousPhotoUrl = ambassador?.photoUrl || '';
  let uploadedPhoto = null;
  let photoUrl = previousPhotoUrl;
  try {
    if (req.file) {
      uploadedPhoto = await uploadBuffer(
        req.file.buffer,
        `brand-ambassador-${Date.now()}`,
        req.file.mimetype,
        { kind: 'brand-ambassador-photo', owner: String(req.roleUser._id) }
      );
      photoUrl = mediaUrl(uploadedPhoto);
    }

    const data = { name, role, bio, photoUrl, isVisible: req.body.isVisible === 'on', displayOrder };
    if (ambassador) Object.assign(ambassador, data);
    else settings.brandAmbassadors.push(data);
    settings.updatedBy = req.roleUser._id;
    await settings.save();
  } catch (error) {
    if (uploadedPhoto) {
      try {
        await deleteFile(uploadedPhoto.cluster, uploadedPhoto.id);
      } catch (cleanupError) {
        logger.warn('Unattached brand ambassador photo could not be deleted', { error: cleanupError });
      }
    }
    logger.error('Brand ambassador could not be saved', error);
    flash(req, 'error', 'The brand ambassador could not be saved. Please try again.');
    return res.redirect('/admin#brand-ambassadors');
  }

  if (uploadedPhoto && previousPhotoUrl) await removeAmbassadorPhoto(previousPhotoUrl);
  await audit(req, ambassador ? 'brand-ambassador-updated' : 'brand-ambassador-created', 'site', settings._id, { name, visible: req.body.isVisible === 'on' });
  flash(req, 'success', `${name} was saved.`);
  res.redirect('/admin#brand-ambassadors');
};

exports.deleteBrandAmbassador = async (req, res) => {
  const settings = await SiteSetting.getSingleton();
  const ambassador = settings.brandAmbassadors.id(req.params.id);
  if (!ambassador) {
    flash(req, 'error', 'That brand ambassador could not be found.');
    return res.redirect('/admin#brand-ambassadors');
  }
  const { _id, name, photoUrl } = ambassador;
  settings.brandAmbassadors.pull(_id);
  settings.updatedBy = req.roleUser._id;
  await settings.save();
  await removeAmbassadorPhoto(photoUrl);
  await audit(req, 'brand-ambassador-deleted', 'site', settings._id, { name });
  flash(req, 'success', `${name} was removed.`);
  res.redirect('/admin#brand-ambassadors');
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
  const moderator = await User.create({ name: name.trim(), email: normalizedEmail, password: await hashPassword(password), role: 'moderator', moderatorId: `MOD-${crypto.randomBytes(5).toString('hex').toUpperCase()}`, isVerified: true });
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
    logEvent(action.target, 'suspended', action.reason);
  }
  if (action.action === 'unsuspend-user') {
    await User.findByIdAndUpdate(action.target, { suspendedUntil: null, suspensionReason: '' });
    logEvent(action.target, 'suspension-lifted');
  }
  if (action.action === 'warn-user') {
    await User.findByIdAndUpdate(action.target, { $push: { warnings: { reason: action.reason, issuedBy: action.moderator } } });
    logEvent(action.target, 'warning-issued', action.reason);
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
  if (action.action === 'resolve-report') {
    const decision = payload.decision === 'dismissed' ? 'dismissed' : 'resolved';
    await Report.findByIdAndUpdate(action.target, { status: decision, reviewedBy: req.roleUser._id, reviewedAt: new Date(), resolution: action.reason });
  }
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
  // A rejected report recommendation shouldn't leave the report stuck in
  // "reviewing" forever with no way for anyone to act on it again.
  else if (action.action === 'resolve-report') await Report.updateOne({ _id: action.target, status: 'reviewing' }, { status: 'open' });
  else if (action.action === 'flag-spam') {
    // Not spam after all: put the post back exactly as it was.
    await Post.findByIdAndUpdate(action.target, { $set: { status: action.payload?.previousStatus || 'published', moderationStatus: 'unreviewed' } });
    clearAllFeedCaches();
  }
  action.status = approved ? 'approved' : 'rejected';
  action.reviewedBy = req.roleUser._id;
  action.reviewedAt = new Date();
  action.reviewNote = req.body.note?.trim().slice(0, 500) || '';
  await action.save();
  await audit(req, `${approved ? 'approve' : 'reject'}-moderation-action`, action.targetType, action.target, { action: action.action, moderator: action.moderator });
  flash(req, 'success', approved ? 'Action approved and applied.' : 'Action rejected.');
  res.redirect('/admin#queue');
};

exports.revertAutoAction = async (req, res) => {
  const action = await ModerationAction.findOne({ _id: req.params.id, autoApplied: true, status: 'approved', revertedAt: null, action: { $in: [...REVERTIBLE_ACTIONS] } });
  if (!action) return res.redirect('/admin#queue');
  if (action.action === 'edit-post' && action.payload?.previousBody !== undefined) await Post.findByIdAndUpdate(action.target, { body: action.payload.previousBody });
  if (action.action === 'rate-good-post') await Post.findByIdAndUpdate(action.target, { $inc: { moderationScore: -1 }, $set: { moderationStatus: 'unreviewed' } });
  if (action.action === 'rate-bad-post') await Post.findByIdAndUpdate(action.target, { $inc: { moderationScore: 1 }, $set: { moderationStatus: 'unreviewed' } });
  action.revertedAt = new Date();
  action.revertedBy = req.roleUser._id;
  await action.save();
  await audit(req, 'revert-moderation-action', action.targetType, action.target, { action: action.action, moderator: action.moderator });
  flash(req, 'success', 'The moderator action was reverted.');
  res.redirect('/admin#queue');
};

exports.moderator = async (req, res) => {
  const reviewThreshold = await getPostReviewThreshold();
  const reportedOnly = req.query.filter === 'reported';
  const contentType = ['post', 'article', 'poll'].includes(req.query.type) ? req.query.type : '';
  const [reports, actions, communities, moderationFeed, pendingAppeals] = await Promise.all([
    Report.find({ status: { $in: ['open', 'reviewing'] } }).sort({ status: 1, createdAt: -1 }).limit(60).select('targetType target reason evidenceUrl status createdAt').populate('reporter', 'name').lean(),
    ModerationAction.find({ moderator: req.roleUser._id }).sort({ createdAt: -1 }).limit(60).select('action targetType target reason status createdAt reviewNote autoApplied revertedAt').lean(),
    Community.find().sort({ membersCount: -1 }).limit(60).select('name slug description guidelines category membersCount requireApproval bannedWords createdAt').lean(),
    // Excludes posts this moderator has already looked at, and posts enough
    // other moderators have already cleared - see moderatorReviews on Post
    // and postReviewThreshold in site settings. ?filter=reported narrows to
    // just posts someone has actually flagged, for a moderator who wants to
    // clear the backlog of real reports before the general queue.
    Post.find({
      status: 'published',
      author: { $ne: req.roleUser._id },
      moderatorReviews: { $ne: req.roleUser._id },
      $expr: { $lt: [{ $size: { $ifNull: ['$moderatorReviews', []] } }, reviewThreshold] },
      ...(reportedOnly ? { moderationStatus: 'reported' } : {}),
      ...(contentType ? { type: contentType } : {})
    }).sort({ moderationStatus: -1, moderationScore: -1, createdAt: -1 }).limit(50).select('body type poll.question poll.options.label author community createdAt moderationScore moderationStatus moderatorReviews').populate('author', 'name profilePicture').populate('community', 'name slug').lean(),
    Appeal.find({ status: 'pending' }).sort({ createdAt: -1 }).limit(80).populate('user', 'name email').lean()
  ]);
  const queueBase = { status: 'published', author: { $ne: req.roleUser._id }, moderatorReviews: { $ne: req.roleUser._id }, $expr: { $lt: [{ $size: { $ifNull: ['$moderatorReviews', []] } }, reviewThreshold] } };
  const typeCountRows = await Post.aggregate([{ $match: { ...queueBase, moderationStatus: 'unreviewed' } }, { $group: { _id: '$type', n: { $sum: 1 } } }]);
  const contentCounts = { post: 0, article: 0, poll: 0 };
  typeCountRows.forEach((row) => { if (row._id in contentCounts) contentCounts[row._id] = row.n; });
  const myOpenReportRecommendations = new Set(actions.filter((a) => a.action === 'resolve-report' && a.status === 'pending').map((a) => String(a.target)));
  res.render('pages/moderator', { contentType, contentCounts, recentAuto: actions.filter((a) => a.autoApplied).slice(0, 8), title: 'Moderator console', pagePath: '/moderator', noIndex: true, reports, actions, communities, moderationFeed, moderator: req.roleUser, reviewThreshold, myOpenReportRecommendations, reportedOnly, pendingAppeals });
};

// Moderation forms are submitted in the background (no page reload). The same handlers
// still work as plain form posts: without the XHR header they flash and redirect.
// Actions after which the post has left this moderator's queue.
const QUEUE_CLEARING_ACTIONS = new Set(['mark-reviewed', 'rate-good-post', 'rate-bad-post', 'flag-spam', 'report-post', 'delete-post']);
const modDone = (req, res, ok, message, remove = QUEUE_CLEARING_ACTIONS.has(req.body?.action)) => {
  if (req.get('X-Requested-With') === 'XMLHttpRequest') return res.json({ ok, message, remove: Boolean(ok && remove) });
  flash(req, ok ? 'success' : 'error', message);
  return res.redirect('/moderator');
};

exports.submitAction = async (req, res) => {
  // A pure "I looked at this, nothing to flag" - it doesn't change anything
  // user-facing, so it doesn't need admin approval or even a reason. It
  // just records that this moderator has reviewed the post, so it stops
  // showing up in their queue (and drops out of everyone's queue once
  // enough moderators have done the same - see the feed query below).
  if (req.body.action === 'mark-reviewed') {
    if (!req.body.target) return modDone(req, res, false, 'Nothing to review.');
    const post = await Post.findOneAndUpdate({ _id: req.body.target, author: { $ne: req.roleUser._id } }, { $addToSet: { moderatorReviews: req.roleUser._id } }, { new: true }).select('_id').lean();
    return modDone(req, res, Boolean(post), post ? 'Marked reviewed.' : 'Moderators cannot review their own posts.');
  }

  const allowed = ['delete-post', 'edit-post', 'suspend-user', 'unsuspend-user', 'warn-user', 'edit-community', 'resolve-report', 'rate-good-post', 'rate-bad-post', 'report-post', 'flag-spam'];
  if (!allowed.includes(req.body.action) || !req.body.target || !req.body.reason?.trim()) return modDone(req, res, false, 'Please add a reason for this action.', false);
  const postActions = ['delete-post', 'edit-post', 'rate-good-post', 'rate-bad-post', 'report-post', 'flag-spam'];
  const userActions = ['suspend-user', 'unsuspend-user', 'warn-user'];
  const targetType = postActions.includes(req.body.action) ? 'post' : userActions.includes(req.body.action) ? 'user' : req.body.action === 'edit-community' ? 'community' : 'report';
  if (postActions.includes(req.body.action)) {
    const post = await Post.findOneAndUpdate({ _id: req.body.target, author: { $ne: req.roleUser._id } }, { $addToSet: { moderatorReviews: req.roleUser._id } }).select('_id').lean();
    if (!post) {
      return modDone(req, res, false, 'Moderators cannot review or influence their own posts.');
    }
  }
  if (LOW_RISK_ACTIONS.has(req.body.action)) {
    const done = await applyLowRiskAction(req, { action: req.body.action, post: { _id: req.body.target }, reason: req.body.reason.trim(), payload: req.body.payload || {} });
    return modDone(req, res, Boolean(done), done ? LOW_RISK_MESSAGES[req.body.action] : 'That action could not be applied.');
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
  if (req.body.action === 'resolve-report') {
    // Reports go to moderators first: they leave a recommendation here,
    // which puts the report into "reviewing" right away so other
    // moderators can see it's being handled, then an admin makes the
    // actual call (see applyApprovedAction / reviewAction).
    const report = await Report.findOne({ _id: req.body.target, status: 'open' });
    if (!report) {
      return modDone(req, res, false, 'That report is already under review or has been closed.');
    }
    payload = { decision: req.body.payload?.decision === 'dismissed' ? 'dismissed' : 'resolved' };
    report.status = 'reviewing';
    await report.save();
  }
  await ModerationAction.create({ moderator: req.roleUser._id, action: req.body.action, targetType, target: req.body.target, reason: req.body.reason.trim(), payload });
  await audit(req, 'submit-moderation-action', targetType, req.body.target, { action: req.body.action });
  return modDone(req, res, true, 'The action was sent to the administrator for approval.');
};

// ---- Bot guard: addresses blocked for 24 hours (see middleware/botGuard.js) ----
exports.blockedIpsPage = async (req, res) => {
  const BlockedIp = require('../models/BlockedIp');
  const rows = await BlockedIp.find({ expiresAt: { $gt: new Date() } }).sort({ blockedAt: -1 }).limit(200).lean();
  res.render('pages/admin-blocked-ips', { title: 'Blocked addresses', noIndex: true, rows, active: 'admin' });
};

exports.unblockIp = async (req, res) => {
  const botGuard = require('../middleware/botGuard');
  const ip = String(req.body.ip || '').trim().slice(0, 80);
  if (!ip) { req.session.flash = { type: 'error', message: 'Choose an address to unblock.' }; return res.redirect('/admin/blocked-ips'); }
  const key = await botGuard.unblock(ip);
  await audit(req, 'bot_guard.unblock', 'BlockedIp', undefined, { ip: key });
  req.session.flash = { type: 'success', message: `${key} can use Crowdwide again.` };
  return res.redirect('/admin/blocked-ips');
};
