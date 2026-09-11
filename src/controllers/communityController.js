const Community = require('../models/Community');
const User = require('../models/User');
const Post = require('../models/Post');

const moderationOnly = async (req, res, next) => {
  const community = await Community.findById(req.params.id);
  const isOwner = community && String(community.owner) === String(req.session.user.id);
  const isModerator = community?.moderators?.some((id) => String(id) === String(req.session.user.id));
  if (!community || (!isOwner && !isModerator)) {
    req.session.flash = { type: 'error', message: 'You do not have moderation access to this community.' };
    return res.redirect('/dashboard');
  }
  req.community = community;
  req.isOwner = isOwner;
  next();
};

const ownerOnly = async (req, res, next) => {
  const community = await Community.findOne({ _id: req.params.id, owner: req.session.user.id });
  if (!community) {
    req.session.flash = { type: 'error', message: 'Only the community owner can manage this community.' };
    return res.redirect('/dashboard');
  }
  req.community = community;
  next();
};

exports.ownerOnly = ownerOnly;
exports.moderationOnly = moderationOnly;
exports.explore = async (req, res) => {
  const query = req.query.q?.trim();
  const category = req.query.category?.trim().toLowerCase();
  const filter = {};
  if (query) filter.$or = [{ name: new RegExp(query, 'i') }, { description: new RegExp(query, 'i') }];
  if (category) filter.category = category;
  const [communities, categories] = await Promise.all([
    Community.find(filter).sort({ membersCount: -1, createdAt: -1 }).limit(30).lean(),
    Community.distinct('category')
  ]);
  res.render('pages/explore', { title: 'Explore communities', pagePath: '/explore', noIndex: true, communities, categories, query: query || '', category: category || '' });
};

exports.detail = async (req, res) => {
  const community = await Community.findOne({ slug: req.params.slug }).populate('owner', 'name profilePicture').lean();
  if (!community) return res.status(404).render('pages/not-found', { title: 'Community not found' });
  const posts = await Post.find({ community: community._id }).sort({ createdAt: -1 }).limit(30).populate('author', 'name profilePicture').lean();
  const joined = community.members.some((id) => String(id) === String(req.session.user.id));
  const requested = community.joinRequests?.some((request) => String(request.user) === String(req.session.user.id));
  res.render('pages/community-detail', { title: community.name, pagePath: `/communities/${community.slug}`, noIndex: true, community, posts, joined, requested, isOwner: community.owner && String(community.owner._id) === String(req.session.user.id) });
};
exports.manage = async (req, res) => {
  const [members, posts, requests, moderators] = await Promise.all([
    User.find({ _id: { $in: req.community.members } }).select('name email profilePicture').lean(),
    Post.find({ community: req.community._id }).sort({ createdAt: -1 }).limit(20).populate('author', 'name profilePicture').lean(),
    User.find({ _id: { $in: req.community.joinRequests.map((request) => request.user) } }).select('name email').lean(),
    User.find({ _id: { $in: req.community.moderators } }).select('name email').lean()
  ]);
  res.render('pages/community-owner', { title: `${req.community.name} controls`, pagePath: `/communities/${req.community._id}/manage`, noIndex: true, community: req.community, members, posts, requests, moderators });
};

exports.update = async (req, res) => {
  req.community.name = req.body.name?.trim() || req.community.name;
  req.community.description = req.body.description?.trim() || req.community.description;
  req.community.category = req.body.category?.trim().toLowerCase() || req.community.category;
  req.community.isPrivate = req.body.isPrivate === 'on';
  req.community.bannedWords = (req.body.bannedWords || '').split(',').map((word) => word.trim().toLowerCase()).filter(Boolean).slice(0, 100);
  await req.community.save();
  req.session.flash = { type: 'success', message: 'Community details updated.' };
  res.redirect(`/communities/${req.community._id}/manage`);
};

exports.requestJoin = async (req, res) => {
  const community = await Community.findOne({ slug: req.params.slug });
  if (!community) return res.redirect('/explore');
  const userId = req.session.user.id;
  if (community.members.some((id) => String(id) === String(userId))) return res.redirect(`/communities/${community.slug}`);
  if (community.isPrivate) {
    if (!community.joinRequests.some((request) => String(request.user) === String(userId))) community.joinRequests.push({ user: userId });
    await community.save();
    req.session.flash = { type: 'success', message: 'Join request sent to the community moderators.' };
  } else {
    community.members.push(userId);
    community.memberRoles.push({ user: userId, role: 'member' });
    community.membersCount = community.members.length;
    await community.save();
    await User.findByIdAndUpdate(userId, { $addToSet: { joinedCommunities: community._id } });
  }
  res.redirect(`/communities/${community.slug}`);
};

exports.reviewRequest = async (req, res) => {
  const request = req.community.joinRequests.find((item) => String(item.user) === req.params.userId);
  if (request && req.body.decision === 'approve') {
    req.community.members.addToSet(request.user);
    req.community.memberRoles.push({ user: request.user, role: 'member' });
    req.community.membersCount = req.community.members.length;
    await User.findByIdAndUpdate(request.user, { $addToSet: { joinedCommunities: req.community._id } });
  }
  req.community.joinRequests = req.community.joinRequests.filter((item) => String(item.user) !== req.params.userId);
  await req.community.save();
  res.redirect(`/communities/${req.community._id}/manage`);
};

exports.setModerator = async (req, res) => {
  if (!req.isOwner || String(req.params.userId) === String(req.community.owner)) return res.redirect(`/communities/${req.community._id}/manage`);
  const member = req.community.members.some((id) => String(id) === req.params.userId);
  if (member && req.body.role === 'moderator') req.community.moderators.addToSet(req.params.userId);
  if (req.body.role !== 'moderator') req.community.moderators.pull(req.params.userId);
  req.community.memberRoles = req.community.memberRoles.map((entry) => String(entry.user) === req.params.userId ? { user: entry.user, role: req.body.role === 'moderator' ? 'moderator' : 'member' } : entry);
  await req.community.save();
  res.redirect(`/communities/${req.community._id}/manage`);
};

exports.removeMember = async (req, res) => {
  const memberId = req.params.memberId;
  if (String(memberId) === String(req.community.owner)) {
    req.session.flash = { type: 'error', message: 'The community owner cannot be removed.' };
    return res.redirect(`/communities/${req.community._id}/manage`);
  }
  req.community.members.pull(memberId);
  req.community.membersCount = req.community.members.length;
  await req.community.save();
  await User.findByIdAndUpdate(memberId, { $pull: { joinedCommunities: req.community._id } });
  req.session.flash = { type: 'success', message: 'Member removed from the community.' };
  res.redirect(`/communities/${req.community._id}/manage`);
};
