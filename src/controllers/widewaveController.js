const User = require('../models/User');
const Post = require('../models/Post');
const WideWave = require('../models/WideWave');
const AuditLog = require('../models/AuditLog');
const svc = require('../services/widewaves');
const SiteSetting = require('../models/SiteSetting');
const logger = require('../services/logger');
const { validateWideWaveName } = require('../utils/widewaveName');
const { uploadBuffer, mediaUrl } = require('../services/storageCluster');
const { attachReplyPostCounts } = require('../services/replyPostCounts');

async function storePicture(req, name) {
  const file = req.file;
  if (!file) return '';
  const stored = await uploadBuffer(file.buffer, file.originalname, file.mimetype, { kind: 'widewave-picture', owner: String(name || 'widewave') });
  return mediaUrl(stored);
}

const flash = (req, type, message) => { req.session.flash = { type, message }; };
const isXhr = (req) => req.get('X-Requested-With') === 'XMLHttpRequest';
const PERIOD_LABELS = { week: 'This week', month: 'This month', year: 'This year', all: 'All time' };

async function viewerOf(req) {
  const id = req.session?.user?.id;
  return id ? User.findById(id).lean() : null;
}

async function featureOn() {
  try {
    const settings = await SiteSetting.getSingleton();
    return settings.widewavesEnabled !== false;
  } catch (error) {
    return true;
  }
}

const disabledPage = (res) => res.status(404).render('pages/not-found', { title: 'Page not found' });

// ------------------------------------------------------------------ public ----

exports.home = async (req, res) => {
  if (!(await featureOn())) return disabledPage(res);
  const viewer = await viewerOf(req);
  const tab = ['for-you', 'trending', 'new'].includes(req.query.tab) ? req.query.tab : (viewer ? 'for-you' : 'trending');
  const page = Math.min(50, Math.max(1, Number.parseInt(req.query.page, 10) || 1));
  const query = String(req.query.q || '').trim().slice(0, 60);
  const results = query ? await svc.searchWideWaves(query, { limit: 20 }) : [];
  const [trending, recommended, board] = await Promise.all([
    svc.trendingWideWaves({ limit: 10 }),
    viewer ? svc.recommendWideWaves(viewer, { limit: 6 }) : Promise.resolve([]),
    svc.leaderboard('week', { limit: 5 })
  ]);
  let feed;
  if (tab === 'for-you') feed = await svc.recommendedWavePosts(viewer, { page });
  else if (tab === 'trending') {
    // Top posts across all WideWaves this month.
    const filter = { widewave: { $ne: null }, status: 'published', moderationStatus: { $ne: 'reported' }, createdAt: { $gte: new Date(Date.now() - 30 * 86400000) } };
    const rows = await Post.aggregate([
      { $match: filter },
      { $addFields: { engagement: { $add: [{ $size: { $ifNull: ['$likes', []] } }, { $multiply: [{ $ifNull: ['$commentsCount', 0] }, 2] }] } } },
      { $sort: { engagement: -1, createdAt: -1 } }, { $skip: (page - 1) * svc.PAGE_SIZE }, { $limit: svc.PAGE_SIZE + 1 }
    ]);
    const mine = viewer ? await require('../utils/profilePrivacy').getHiddenAuthorIds(viewer._id, viewer.following) : await require('../utils/profilePrivacy').getHiddenAuthorIds(null);
    const hidden = new Set([...mine.map(String), ...(viewer?.blockedUsers || []).map(String), ...(viewer?.mutedUsers || []).map(String)]);
    const visible = rows.filter((post) => !hidden.has(String(post.author)));
    feed = { posts: await decorate(visible.slice(0, svc.PAGE_SIZE), viewer), hasMore: rows.length > svc.PAGE_SIZE };
  } else {
    const filter = { widewave: { $ne: null }, status: 'published', moderationStatus: { $ne: 'reported' } };
    const hiddenAuthors = await require('../utils/profilePrivacy').getHiddenAuthorIds(viewer?._id || null, viewer?.following || null);
    filter.author = { $nin: [...hiddenAuthors, ...(viewer?.blockedUsers || []), ...(viewer?.mutedUsers || [])] };
    const rows = await Post.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * svc.PAGE_SIZE).limit(svc.PAGE_SIZE + 1).lean();
    feed = { posts: await decorate(rows.slice(0, svc.PAGE_SIZE), viewer), hasMore: rows.length > svc.PAGE_SIZE };
  }
  res.render('pages/widewaves', {
    title: 'WideWaves',
    pagePath: '/widewaves',
    description: 'Open topic spaces for everyone. Read, post and join in on ww/ topics like poetry, gaming and art, no joining needed.',
    tab, page, feed, trending, recommended, board, query, results
  });
};

async function decorate(posts, viewer) {
  const populated = await Post.populate(posts, [
    { path: 'author', select: 'name profilePicture' },
    { path: 'coAuthors', select: 'name profilePicture' },
    { path: 'widewave', select: 'name' },
    { path: 'quotedPost', select: 'body author', populate: { path: 'author', select: 'name profilePicture' } },
    { path: 'replyTo', select: 'body author', populate: { path: 'author', select: 'name profilePicture' } }
  ]);
  const uid = viewer ? String(viewer._id) : null;
  const saved = new Set((viewer?.bookmarks || []).map(String));
  const withReplyCounts = await attachReplyPostCounts(populated);
  return withReplyCounts.map((post) => ({ ...post, liked: uid ? (post.likes || []).some((id) => String(id) === uid) : false, bookmarked: saved.has(String(post._id)), feedSource: post.widewave?.name ? `ww/${post.widewave.name}` : undefined }));
}

exports.show = async (req, res) => {
  if (!(await featureOn())) return disabledPage(res);
  const wave = await svc.findActiveByName(req.params.name);
  if (!wave) return res.status(404).render('pages/not-found', { title: 'WideWave not found' });
  const viewer = await viewerOf(req);
  const sort = req.query.sort === 'top' ? 'top' : 'new';
  const page = Math.min(50, Math.max(1, Number.parseInt(req.query.page, 10) || 1));
  const [feed, contributors, creator, related] = await Promise.all([
    svc.wavePosts(wave, viewer, { sort, page }),
    svc.topContributors(wave, 'week'),
    User.findById(wave.creator).select('name profilePicture privacy').lean(),
    wave.hashtags.length ? WideWave.find({ status: 'active', _id: { $ne: wave._id }, hashtags: { $in: wave.hashtags } }).sort({ postsCount: -1 }).limit(5).lean() : []
  ]);
  const [weekPosts, totalPosts] = await Promise.all([
    Post.countDocuments({ widewave: wave._id, status: 'published', createdAt: { $gte: new Date(Date.now() - 7 * 86400000) } }),
    Post.countDocuments({ widewave: wave._id, status: 'published' })
  ]);
  res.render('pages/widewave', {
    title: `ww/${wave.name}`,
    pagePath: `/ww/${wave.name}`,
    description: wave.description,
    wave: wave.toObject(), sort, page, feed, contributors, related, weekPosts, totalPosts,
    creator: creator && creator.privacy !== 'followers' ? creator : (creator ? { name: creator.name, _id: creator._id, profilePicture: creator.profilePicture } : null),
    isCreator: Boolean(viewer && String(viewer._id) === String(wave.creator)),
    isStaff: Boolean(viewer && ['admin', 'moderator'].includes(viewer.role))
  });
};

exports.leaderboardPage = async (req, res) => {
  if (!(await featureOn())) return disabledPage(res);
  const period = Object.keys(PERIOD_LABELS).includes(req.query.period) ? req.query.period : 'week';
  const rows = await svc.leaderboard(period, { limit: 25 });
  res.render('pages/widewave-leaderboard', {
    title: 'WideWave leaderboard',
    pagePath: '/widewaves/leaderboard',
    description: 'Which WideWaves got the most posts this week, this month and of all time.',
    period, periods: PERIOD_LABELS, rows
  });
};

// JSON for the composer popup: trending when empty, matches when searching.
exports.search = async (req, res) => {
  if (!(await featureOn())) return res.json({ ok: true, results: [], trending: [] });
  const q = String(req.query.q || '').slice(0, 60);
  const results = q.trim() ? await svc.searchWideWaves(q, { limit: 12 }) : [];
  const trending = q.trim() ? [] : await svc.trendingWideWaves({ limit: 10 });
  const shape = (wave) => ({ name: wave.name, description: wave.description, posts: wave.postsCount || 0, weekPosts: wave.weekPosts || 0 });
  const valid = validateWideWaveName(q);
  res.json({ ok: true, query: q, results: results.map(shape), trending: trending.map(shape), canCreate: Boolean(q.trim()) && valid.ok && !results.some((wave) => wave.name === valid.name), suggestedName: valid.ok ? valid.name : '' });
};

// ----------------------------------------------------------------- members ----

exports.newPage = async (req, res) => {
  if (!(await featureOn())) return disabledPage(res);
  res.render('pages/widewave-new', { title: 'Create a WideWave', pagePath: '/widewaves/new', noIndex: true, form: { name: String(req.query.name || '').slice(0, 30), description: '', hashtags: '' }, limits: { perDay: svc.MAX_CREATED_PER_DAY } });
};

exports.create = async (req, res) => {
  if (!(await featureOn())) return disabledPage(res);
  try {
    const wave = await svc.createWideWave({ userId: req.session.user.id, name: req.body.name, description: req.body.description, hashtags: req.body.hashtags, picture: await storePicture(req, req.body.name) });
    flash(req, 'success', `ww/${wave.name} is live. Be the first to post in it!`);
    return res.redirect(`/ww/${wave.name}`);
  } catch (error) {
    if (!(error instanceof svc.WideWaveError)) throw error;
    flash(req, 'error', error.message);
    return res.status(400).render('pages/widewave-new', { title: 'Create a WideWave', pagePath: '/widewaves/new', noIndex: true, form: { name: String(req.body.name || '').slice(0, 40), description: String(req.body.description || '').slice(0, 200), hashtags: String(req.body.hashtags || '').slice(0, 200) }, limits: { perDay: svc.MAX_CREATED_PER_DAY }, flash: { type: 'error', message: error.message } });
  }
};

exports.edit = async (req, res) => {
  const wave = await svc.findActiveByName(req.params.name);
  if (!wave) return res.status(404).render('pages/not-found', { title: 'WideWave not found' });
  try {
    await svc.updateWideWave({ wave, userId: req.session.user.id, description: req.body.description, hashtags: req.body.hashtags, picture: await storePicture(req, wave.name), removePicture: req.body.removePicture === 'on' });
    flash(req, 'success', 'WideWave updated.');
  } catch (error) {
    if (!(error instanceof svc.WideWaveError)) throw error;
    flash(req, 'error', error.message);
  }
  return res.redirect(`/ww/${wave.name}`);
};

exports.remove = async (req, res) => {
  const wave = await svc.findActiveByName(req.params.name);
  if (!wave) return res.status(404).render('pages/not-found', { title: 'WideWave not found' });
  try {
    const { moved } = await svc.deleteWideWave({ wave, actorId: req.session.user.id });
    flash(req, 'success', `ww/${wave.name} was deleted. Its ${moved} post${moved === 1 ? '' : 's'} stay on Crowdwide as normal posts.`);
    return res.redirect('/widewaves');
  } catch (error) {
    if (!(error instanceof svc.WideWaveError)) throw error;
    flash(req, 'error', error.message);
    return res.redirect(`/ww/${wave.name}`);
  }
};

// --------------------------------------------------------- official moderators ----
// WideWaves are moderated only by official Crowdwide moderators and admins; creators
// get no moderation powers. Both actions answer JSON so the panel updates live.

const staffDone = (req, res, ok, message, extra = {}) => {
  if (isXhr(req)) return res.json({ ok, message, remove: Boolean(ok), ...extra });
  flash(req, ok ? 'success' : 'error', message);
  return res.redirect(req.get('referer') || '/moderator');
};

exports.staffRemoveWave = async (req, res) => {
  if (!svc.objectId(req.params.id)) return staffDone(req, res, false, 'Unknown WideWave.');
  const wave = await WideWave.findOne({ _id: req.params.id, status: 'active' });
  if (!wave) return staffDone(req, res, false, 'That WideWave is already gone.');
  const reason = String(req.body.reason || '').trim().slice(0, 300);
  if (!reason) return staffDone(req, res, false, 'Add a reason before removing a WideWave.');
  const { moved } = await svc.deleteWideWave({ wave, actorId: req.session.user.id, staff: true, reason });
  await AuditLog.create({ actor: req.session.user.id, action: 'remove-widewave', targetType: 'widewave', target: wave._id, details: { name: wave.name, reason, moved }, ipAddress: req.ip, userAgent: req.get('user-agent') }).catch((error) => logger.error('Audit log failed', error));
  return staffDone(req, res, true, `ww/${wave.name} removed. ${moved} post${moved === 1 ? '' : 's'} became normal posts.`);
};

exports.staffUnlinkPost = async (req, res) => {
  if (!svc.objectId(req.params.postId)) return staffDone(req, res, false, 'Unknown post.');
  const post = await Post.findOneAndUpdate({ _id: req.params.postId, widewave: { $ne: null } }, { $set: { widewave: null } }, { new: false }).select('widewave').lean();
  if (!post) return staffDone(req, res, false, 'That post is not in a WideWave.');
  await svc.recountWideWave(post.widewave);
  await AuditLog.create({ actor: req.session.user.id, action: 'unlink-widewave-post', targetType: 'post', target: req.params.postId, details: { widewave: post.widewave }, ipAddress: req.ip, userAgent: req.get('user-agent') }).catch((error) => logger.error('Audit log failed', error));
  return staffDone(req, res, true, 'Post moved out of the WideWave.');
};

// Lists WideWaves for the moderator and admin panels.
exports.panelList = async () => WideWave.find({ status: 'active' }).sort({ createdAt: -1 }).limit(40).populate('creator', 'name').lean();
