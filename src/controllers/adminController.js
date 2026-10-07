const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { hashPassword } = require('../utils/passwords');
const User = require('../models/User');
const Post = require('../models/Post');
const Community = require('../models/Community');
const Report = require('../models/Report');
const AuditLog = require('../models/AuditLog');
const ModerationAction = require('../models/ModerationAction');
const SiteSetting = require('../models/SiteSetting');
const MaintenanceRun = require('../models/MaintenanceRun');
const Appeal = require('../models/Appeal');
const Advertiser = require('../models/Advertiser');
const Campaign = require('../models/Campaign');
const { logEvent } = require('../services/accountHistory');
const { getSiteConfig, clearSiteConfigCache, getPostReviewThreshold } = require('../services/siteConfig');
const { runMaintenance, TASK_LABELS } = require('../services/maintenance');
const { getMongoStorage, formatStorage } = require('../services/mongoStorage');
const { adjustWaves } = require('../services/waves');
const { reviewCampaignAsModerator, updateAdvertiserStatus, updateCampaignStatus } = require('../services/advertising');
const { COMMUNITY_CATEGORIES, normalizeCommunityCategory } = require('../utils/communityCategories');
const logger = require('../services/logger');

const flash = (req, type, message) => { req.session.flash = { type, message }; };
const audit = (req, action, targetType, target, details = {}) => AuditLog.create({ actor: req.roleUser._id, action, targetType, target, details, ipAddress: req.ip, userAgent: req.get('user-agent') });
const panelRoles = { admin: ['admin'], moderator: ['admin', 'moderator'] };
const postModerationActions = ['delete-post', 'suspend-user', 'rate-good-post', 'rate-bad-post', 'report-post'];
const DAY_MS = 24 * 60 * 60 * 1000;
const SUSPENSION_MS = 365 * DAY_MS; // fallback used only where a site-config lookup isn't already in hand

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
  const user = await User.findById(req.session.user.id).select('password role');
  if (!user || !panelRoles[panel].includes(user.role)) return res.status(403).render('pages/not-found', { title: 'Access denied' });
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
  const [users, communities, posts, openReports, pendingActions, pendingAppeals, moderators, auditLogs, maintenanceRuns, siteSettings, mongoStorage, pendingMonetization, pendingAdvertisers, pendingCampaigns] = await Promise.all([
    User.find().sort({ createdAt: -1 }).limit(80).select('name email role moderatorId isVerified createdAt suspendedUntil suspensionReason postingRestrictedUntil postingRestrictionReason warnings').lean(),
    Community.find().sort({ createdAt: -1 }).limit(60).select('name slug description guidelines category isPrivate requireApproval bannedWords owner membersCount members moderators pinnedPosts monetizationStatus monetizationApplication monetizationSettings createdAt').populate('owner', 'name email').lean(),
    Post.find().sort({ moderationScore: -1, createdAt: -1 }).limit(40).select('body type status contentWarning author community createdAt likes commentsCount sharesCount moderationScore moderationStatus').populate('author', 'name email').populate('community', 'name').lean(),
    Report.find({ status: { $in: ['open', 'reviewing'] } }).sort({ createdAt: -1 }).limit(80).populate('reporter', 'name email').lean(),
    ModerationAction.find({ status: 'pending' }).sort({ createdAt: -1 }).limit(80).populate('moderator', 'name moderatorId').lean(),
    Appeal.find({ status: 'pending' }).sort({ createdAt: -1 }).limit(80).populate('user', 'name email').lean(),
    User.find({ role: 'moderator' }).select('name email moderatorId isVerified createdAt loginLockedUntil').sort({ createdAt: -1 }).lean(),
    AuditLog.find().sort({ createdAt: -1 }).limit(100).populate('actor', 'name email role moderatorId').lean(),
    MaintenanceRun.find().sort({ createdAt: -1 }).limit(30).populate('triggeredBy', 'name').lean(),
    SiteSetting.getSingleton(),
    getMongoStorage(),
    Community.find({ monetizationStatus: 'pending' }).sort({ updatedAt: -1 }).limit(30).select('name slug owner monetizationApplication monetizationStatus monetizationSettings createdAt').populate('owner', 'name email').lean(),
    Advertiser.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(50).populate('user', 'name email').lean(),
    Campaign.find({ status: 'submitted', 'moderatorReview.status': { $in: ['cleared', 'flagged'] } }).sort({ createdAt: 1 }).limit(50).populate({ path: 'advertiser', populate: { path: 'user', select: 'name email' } }).lean()
  ]);
  const pinnedPostIds = new Set(communities.flatMap((community) => (community.pinnedPosts || []).map((id) => String(id))));
  await attachActionContext(pendingActions);
  res.render('pages/admin', { title: 'Admin console', pagePath: '/admin', noIndex: true, users, communities, posts, openReports, pendingActions, pendingAppeals, moderators, auditLogs, maintenanceRuns, maintenanceTaskLabels: TASK_LABELS, communityCategories: COMMUNITY_CATEGORIES, siteSettings, pinnedPostIds, mongoStorage, formatStorage, pendingMonetization, pendingAdvertisers, pendingCampaigns, stats: { users: await User.countDocuments(), communities: await Community.countDocuments(), posts: await Post.countDocuments(), reports: await Report.countDocuments() } });
};

exports.reviewAdvertiser = async (req, res) => {
  const status = req.body.decision;
  const reason = String(req.body.reason || '').trim().slice(0, 500);
  try {
    const advertiser = await updateAdvertiserStatus({
      advertiserId: req.params.id,
      status,
      reason,
      actorId: req.roleUser._id
    });
    await audit(req, `advertiser-${status}`, 'advertiser', advertiser._id, { reason });
    flash(req, 'success', `Advertiser application ${status}.`);
  } catch (error) {
    logger.warn('Admin advertiser review failed', { advertiserId: req.params.id, error });
    flash(req, 'error', error.message || 'Advertiser review could not be completed.');
  }
  res.redirect('/admin#communities');
};

exports.reviewCampaign = async (req, res) => {
  const decision = req.body.decision;
  const reason = String(req.body.reason || '').trim().slice(0, 500);
  if (!['approved', 'rejected'].includes(decision)) {
    flash(req, 'error', 'Choose approve or reject for campaign review.');
    return res.redirect('/admin#communities');
  }
  try {
    const campaign = await updateCampaignStatus({
      campaignId: req.params.id,
      status: decision,
      rejectionReason: reason,
      actorId: req.roleUser._id
    });
    await audit(req, `campaign-${decision}`, 'campaign', campaign._id, { reason });
    flash(req, 'success', `Campaign ${decision}${campaign.fundingStatus === 'refunded' ? '; unused Waves were refunded.' : '.'}`);
  } catch (error) {
    logger.warn('Admin campaign review failed', { campaignId: req.params.id, error });
    flash(req, 'error', error.message || 'Campaign review could not be completed.');
  }
  res.redirect('/admin#communities');
};

exports.reviewCampaignAsModerator = async (req, res) => {
  const decision = String(req.body.decision || '');
  const reason = String(req.body.reason || '').trim().slice(0, 500);
  try {
    const campaign = await reviewCampaignAsModerator({
      campaignId: req.params.id,
      decision,
      reason,
      moderatorId: req.roleUser._id
    });
    await audit(req, `campaign-moderator-${decision}`, 'campaign', campaign._id, { reason });
    flash(req, 'success', decision === 'cleared' ? 'Campaign cleared for final admin review.' : 'Campaign flagged for final admin review.');
  } catch (error) {
    logger.warn('Moderator campaign review failed', { campaignId: req.params.id, moderatorId: req.roleUser._id, error });
    flash(req, 'error', error.message || 'Campaign review could not be completed.');
  }
  res.redirect('/moderator#campaigns');
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
  if (approve) {
    if (appeal.actionType === 'suspension') await User.findByIdAndUpdate(appeal.user, { suspendedUntil: null, suspensionReason: '' });
    else if (appeal.actionType === 'posting-restriction') await User.findByIdAndUpdate(appeal.user, { postingRestrictedUntil: null, postingRestrictionReason: '' });
    else if (appeal.actionType === 'warning') await User.findByIdAndUpdate(appeal.user, { $pull: { warnings: { _id: appeal.warningId } } });
  }
  appeal.status = approve ? 'approved' : 'denied';
  appeal.reviewedBy = req.roleUser._id;
  appeal.reviewedAt = new Date();
  appeal.reviewNote = req.body.note?.trim().slice(0, 500) || '';
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

exports.reviewMonetization = async (req, res) => {
  const community = await Community.findById(req.params.id);
  if (!community) return res.redirect('/admin#communities');

  const decision = req.body.decision || 'approve';
  const note = req.body.note?.trim().slice(0, 500) || '';

  if (decision === 'approve') {
    community.monetizationStatus = 'approved';
    community.isMonetized = true;
    community.monetizationApprovedAt = new Date();
    community.monetizationSettings = {
      ...(community.monetizationSettings || {}),
      adsEnabled: req.body.adsEnabled === 'on',
      adPlacement: req.body.adPlacement || community.monetizationSettings?.adPlacement || 'feed',
      adFrequency: Number(req.body.adFrequency) || community.monetizationSettings?.adFrequency || 1,
      revenueSharePercent: Number(req.body.revenueSharePercent) || community.monetizationSettings?.revenueSharePercent || 0,
      requiresAdminReview: true
    };
    community.monetizationHistory = [
      ...(community.monetizationHistory || []).slice(-9),
      { status: 'approved', action: 'approved', note: note || 'Community monetization approved by admin.', createdAt: new Date(), actor: req.roleUser._id }
    ];
  } else if (decision === 'reject') {
    community.monetizationStatus = 'rejected';
    community.isMonetized = false;
    community.monetizationApplication = {
      ...(community.monetizationApplication || {}),
      rejectionReason: note || 'This community did not meet the monetization requirements.'
    };
    community.monetizationHistory = [
      ...(community.monetizationHistory || []).slice(-9),
      { status: 'rejected', action: 'rejected', note: note || 'Community monetization application rejected.', createdAt: new Date(), actor: req.roleUser._id }
    ];
  } else if (decision === 'pause') {
    community.monetizationStatus = 'paused';
    community.isMonetized = false;
    community.monetizationSettings = { ...(community.monetizationSettings || {}), adsEnabled: false };
    community.monetizationHistory = [
      ...(community.monetizationHistory || []).slice(-9),
      { status: 'paused', action: 'paused', note: note || 'Monetization was paused by admin.', createdAt: new Date(), actor: req.roleUser._id }
    ];
  }

  community.monetizationUpdatedAt = new Date();
  await community.save();
  await audit(req, 'review-community-monetization', 'community', community._id, { decision, note });
  flash(req, 'success', `Monetization status updated to ${community.monetizationStatus}.`);
  res.redirect('/admin#communities');
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
  const postWordLimit = Number(req.body.postWordLimit);
  if (Number.isFinite(postWordLimit) && postWordLimit >= 10) settings.postWordLimit = Math.min(2000, Math.round(postWordLimit));
  const articleWordLimit = Number(req.body.articleWordLimit);
  if (Number.isFinite(articleWordLimit) && articleWordLimit >= 50) settings.articleWordLimit = Math.min(20000, Math.round(articleWordLimit));
  const suspensionDefaultDays = Number(req.body.suspensionDefaultDays);
  if (Number.isFinite(suspensionDefaultDays) && suspensionDefaultDays >= 1) settings.suspensionDefaultDays = Math.min(3650, Math.round(suspensionDefaultDays));
  const postReviewThreshold = Number(req.body.postReviewThreshold);
  if (Number.isFinite(postReviewThreshold) && postReviewThreshold >= 1) settings.postReviewThreshold = Math.min(50, Math.round(postReviewThreshold));
  const monetizationMinimumPosts = Number(req.body.monetizationMinimumPosts);
  if (Number.isFinite(monetizationMinimumPosts) && monetizationMinimumPosts >= 0) settings.monetizationMinimumPosts = Math.min(10000, Math.round(monetizationMinimumPosts));
  const monetizationMinimumLikes = Number(req.body.monetizationMinimumLikes);
  if (Number.isFinite(monetizationMinimumLikes) && monetizationMinimumLikes >= 0) settings.monetizationMinimumLikes = Math.min(100000, Math.round(monetizationMinimumLikes));
  const monetizationMinimumComments = Number(req.body.monetizationMinimumComments);
  if (Number.isFinite(monetizationMinimumComments) && monetizationMinimumComments >= 0) settings.monetizationMinimumComments = Math.min(100000, Math.round(monetizationMinimumComments));
  for (const [field, formName] of [
    ['wavesPostReward', 'post'],
    ['wavesCommentReward', 'comment'],
    ['wavesLikeReward', 'like'],
    ['wavesReceivedCommentReward', 'receivedComment'],
    ['wavesCommunityJoinReward', 'communityJoin'],
    ['wavesCommunityCreateReward', 'communityCreate'],
    ['wavesQuestCompletionReward', 'questCompletion']
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
  settings.updatedBy = req.roleUser._id;
  await settings.save();
  clearSiteConfigCache();
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
  const reviewThreshold = await getPostReviewThreshold();
  const reportedOnly = req.query.filter === 'reported';
  const [reports, actions, communities, moderationFeed, pendingAppeals, pendingCampaigns] = await Promise.all([
    Report.find({ status: { $in: ['open', 'reviewing'] } }).sort({ status: 1, createdAt: -1 }).limit(60).select('targetType target reason evidenceUrl status createdAt').populate('reporter', 'name').lean(),
    ModerationAction.find({ moderator: req.roleUser._id }).sort({ createdAt: -1 }).limit(60).select('action targetType target reason status createdAt reviewNote').lean(),
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
      ...(reportedOnly ? { moderationStatus: 'reported' } : {})
    }).sort({ moderationStatus: -1, moderationScore: -1, createdAt: -1 }).limit(50).select('body type author community createdAt moderationScore moderationStatus moderatorReviews').populate('author', 'name profilePicture').populate('community', 'name slug').lean(),
    Appeal.find({ status: 'pending' }).sort({ createdAt: -1 }).limit(80).populate('user', 'name email').lean(),
    Campaign.find({ status: 'submitted', 'moderatorReview.status': 'pending' }).sort({ createdAt: 1 }).limit(50).populate({ path: 'advertiser', populate: { path: 'user', select: 'name' } }).lean()
  ]);
  const myOpenReportRecommendations = new Set(actions.filter((a) => a.action === 'resolve-report' && a.status === 'pending').map((a) => String(a.target)));
  res.render('pages/moderator', { title: 'Moderator console', pagePath: '/moderator', noIndex: true, reports, actions, communities, moderationFeed, moderator: req.roleUser, reviewThreshold, myOpenReportRecommendations, reportedOnly, pendingAppeals, pendingCampaigns });
};

exports.submitAction = async (req, res) => {
  // A pure "I looked at this, nothing to flag" - it doesn't change anything
  // user-facing, so it doesn't need admin approval or even a reason. It
  // just records that this moderator has reviewed the post, so it stops
  // showing up in their queue (and drops out of everyone's queue once
  // enough moderators have done the same - see the feed query below).
  if (req.body.action === 'mark-reviewed') {
    if (!req.body.target) return res.redirect('/moderator');
    const post = await Post.findOneAndUpdate({ _id: req.body.target, author: { $ne: req.roleUser._id } }, { $addToSet: { moderatorReviews: req.roleUser._id } }, { new: true }).select('_id').lean();
    if (post) flash(req, 'success', 'Marked reviewed.');
    return res.redirect('/moderator');
  }

  const allowed = ['delete-post', 'edit-post', 'suspend-user', 'unsuspend-user', 'warn-user', 'edit-community', 'resolve-report', 'rate-good-post', 'rate-bad-post', 'report-post'];
  if (!allowed.includes(req.body.action) || !req.body.target || !req.body.reason?.trim()) return res.redirect('/moderator');
  const postActions = ['delete-post', 'edit-post', 'rate-good-post', 'rate-bad-post', 'report-post'];
  const userActions = ['suspend-user', 'unsuspend-user', 'warn-user'];
  const targetType = postActions.includes(req.body.action) ? 'post' : userActions.includes(req.body.action) ? 'user' : req.body.action === 'edit-community' ? 'community' : 'report';
  if (postActions.includes(req.body.action)) {
    const post = await Post.findOneAndUpdate({ _id: req.body.target, author: { $ne: req.roleUser._id } }, { $addToSet: { moderatorReviews: req.roleUser._id } }).select('_id').lean();
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
  if (req.body.action === 'resolve-report') {
    // Reports go to moderators first: they leave a recommendation here,
    // which puts the report into "reviewing" right away so other
    // moderators can see it's being handled, then an admin makes the
    // actual call (see applyApprovedAction / reviewAction).
    const report = await Report.findOne({ _id: req.body.target, status: 'open' });
    if (!report) {
      flash(req, 'error', 'That report is already under review or has been closed.');
      return res.redirect('/moderator');
    }
    payload = { decision: req.body.payload?.decision === 'dismissed' ? 'dismissed' : 'resolved' };
    report.status = 'reviewing';
    await report.save();
  }
  await ModerationAction.create({ moderator: req.roleUser._id, action: req.body.action, targetType, target: req.body.target, reason: req.body.reason.trim(), payload });
  await audit(req, 'submit-moderation-action', targetType, req.body.target, { action: req.body.action });
  flash(req, 'success', 'The action was sent to the administrator for approval.');
  res.redirect('/moderator');
};
