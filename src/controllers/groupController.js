// Group chats: create, list, and everything about managing one - name, picture,
// members, admins, invite link, leaving. The chat itself (messages) lives in
// chatController.

const crypto = require('crypto');
const GroupConversation = require('../models/GroupConversation');
const GroupMessage = require('../models/GroupMessage');
const User = require('../models/User');
const logger = require('../services/logger');
const { uploadBuffer, mediaUrl } = require('../services/storageCluster');
const { notify } = require('./interactionController');

const MAX_MEMBERS = 50;
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const same = (a, b) => String(a?._id || a) === String(b?._id || b);

function memberOf(group, userId) {
  // group.members may be raw ObjectIds (unpopulated queries) or populated
  // user documents (e.g. .populate('members', ...)) -- handle both.
  return Boolean(group?.members?.some((member) => same(member, userId)));
}

// The owner (creator) is always an admin, including for groups made before
// admins existed.
function isAdmin(group, userId) {
  return same(group?.creator, userId) || Boolean(group?.admins?.some((admin) => same(admin, userId)));
}

function flash(req, type, message) {
  req.session.flash = { type, message };
}

async function systemNote(groupId, actorId, text) {
  await GroupMessage.create({ group: groupId, sender: actorId, kind: 'system', body: text });
  await GroupConversation.updateOne({ _id: groupId }, { updatedAt: new Date() });
}

// Loads the group and checks the person may manage it. Sends the response
// itself (and returns null) when they may not.
async function loadManageable(req, res, { adminOnly = true } = {}) {
  const group = await GroupConversation.findById(req.params.id);
  if (!group || !memberOf(group, req.session.user.id)) {
    res.status(404).render('pages/not-found', { title: 'Group not found' });
    return null;
  }
  if (adminOnly && !isAdmin(group, req.session.user.id)) {
    flash(req, 'error', 'Only group admins can do that.');
    res.redirect(`/groups/${group._id}/info`);
    return null;
  }
  return group;
}

// Finds verified people by email / exact name or by id, skipping anyone blocked
// in either direction with the person adding them.
async function resolveNewMembers({ identifiers = [], ids = [], adderId, exclude = [] }) {
  const adder = await User.findById(adderId).select('blockedUsers').lean();
  const blocked = new Set((adder?.blockedUsers || []).map(String));
  const skip = new Set(exclude.map(String));
  const found = new Map();
  const consider = (user) => {
    if (!user || found.has(String(user._id)) || skip.has(String(user._id)) || blocked.has(String(user._id))) return;
    if ((user.blockedUsers || []).some((id) => String(id) === String(adderId))) return;
    found.set(String(user._id), user);
  };
  const byIdentifier = await Promise.all(identifiers.map((identifier) => User.findOne({ isVerified: true, $or: [{ email: identifier }, { name: new RegExp(`^${escapeRegex(identifier)}$`, 'i') }] }).select('_id name blockedUsers').lean()));
  byIdentifier.forEach(consider);
  const validIds = ids.filter((id) => /^[a-f\d]{24}$/i.test(String(id)));
  if (validIds.length) (await User.find({ _id: { $in: validIds }, isVerified: true }).select('_id name blockedUsers').lean()).forEach(consider);
  return Array.from(found.values());
}

const splitIdentifiers = (value) => String(value || '').split(/[,\n]+/).map((item) => item.trim().toLowerCase()).filter(Boolean).slice(0, 30);
const toArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);

exports.list = async (req, res) => {
  try {
    const groups = await GroupConversation.find({ members: req.session.user.id }).sort({ updatedAt: -1 }).populate('members', 'name profilePicture').lean();
    res.render('pages/groups', { title: 'Group conversations', pagePath: '/groups', noIndex: true, groups });
  } catch (error) {
    logger.error('Loading group conversations failed', error);
    res.status(500).render('pages/not-found', { title: 'Crowdwide is having trouble' });
  }
};

exports.create = async (req, res) => {
  try {
    const name = req.body.name?.trim();
    if (!name || name.length > 80) {
      flash(req, 'error', 'Give the group a name.');
      return res.redirect('/groups');
    }
    const people = await resolveNewMembers({ identifiers: splitIdentifiers(req.body.members), adderId: req.session.user.id, exclude: [req.session.user.id] });
    if (!people.length) {
      flash(req, 'error', 'Add at least one verified member by email or display name.');
      return res.redirect('/groups');
    }
    const members = [String(req.session.user.id), ...people.map((user) => String(user._id))].slice(0, MAX_MEMBERS);
    const group = await GroupConversation.create({ name, creator: req.session.user.id, admins: [req.session.user.id], members });
    await systemNote(group._id, req.session.user.id, `created the group "${name}".`);
    people.forEach((user) => notify(user._id, req.session.user.id, 'message', `added you to ${name}.`, undefined, undefined, req.session.user.name, `/groups/${group._id}`).catch(() => {}));
    res.redirect(`/groups/${group._id}`);
  } catch (error) {
    logger.error('Creating group conversation failed', error);
    flash(req, 'error', 'That group could not be created.');
    res.redirect('/groups');
  }
};

// ---- group info / settings page ------------------------------------------

exports.info = async (req, res) => {
  try {
    const group = await GroupConversation.findById(req.params.id).populate('members', 'name profilePicture').lean();
    if (!group || !memberOf(group, req.session.user.id)) return res.status(404).render('pages/not-found', { title: 'Group not found' });
    const admin = isAdmin(group, req.session.user.id);
    let suggestions = [];
    if (admin) {
      const viewer = await User.findById(req.session.user.id).select('following').lean();
      const memberIds = new Set(group.members.map((member) => String(member._id)));
      const followingIds = (viewer?.following || []).filter((id) => !memberIds.has(String(id))).slice(-30);
      suggestions = followingIds.length ? await User.find({ _id: { $in: followingIds }, isVerified: true }).select('name profilePicture').lean() : [];
    }
    const base = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    res.render('pages/group-settings', {
      title: `${group.name} · Group info`,
      pagePath: `/groups/${group._id}/info`,
      noIndex: true,
      group,
      isAdmin: admin,
      isOwner: same(group.creator, req.session.user.id),
      adminIds: new Set([String(group.creator), ...(group.admins || []).map(String)]),
      suggestions,
      maxMembers: MAX_MEMBERS,
      inviteUrl: group.inviteCode ? `${base.replace(/\/$/, '')}/groups/join/${group.inviteCode}` : ''
    });
  } catch (error) {
    logger.error('Loading group info failed', error);
    res.status(500).render('pages/not-found', { title: 'Crowdwide is having trouble' });
  }
};

exports.rename = async (req, res) => {
  try {
    const group = await loadManageable(req, res);
    if (!group) return;
    const name = String(req.body.name || '').trim();
    const description = String(req.body.description || '').trim().slice(0, 240);
    if (!name || name.length > 80) {
      flash(req, 'error', 'A group name needs 1 to 80 characters.');
      return res.redirect(`/groups/${group._id}/info`);
    }
    const renamed = name !== group.name;
    const previous = group.name;
    group.name = name;
    group.description = description;
    await group.save();
    if (renamed) await systemNote(group._id, req.session.user.id, `renamed the group from "${previous}" to "${name}".`);
    flash(req, 'success', 'Group details saved.');
    res.redirect(`/groups/${group._id}/info`);
  } catch (error) {
    logger.error('Renaming group failed', error);
    flash(req, 'error', 'Could not save the group details.');
    res.redirect(`/groups/${req.params.id}/info`);
  }
};

exports.setAvatar = async (req, res) => {
  try {
    const group = await loadManageable(req, res);
    if (!group) return;
    const picture = req.file;
    if (!picture) {
      flash(req, 'error', 'Choose an image (JPG, PNG, WebP or GIF, under 1.5MB).');
      return res.redirect(`/groups/${group._id}/info`);
    }
    const stored = await uploadBuffer(picture.buffer, picture.originalname, picture.mimetype, { kind: 'group-picture', owner: group._id.toString() });
    group.avatar = mediaUrl(stored);
    await group.save();
    await systemNote(group._id, req.session.user.id, 'changed the group picture.');
    flash(req, 'success', 'Group picture updated.');
    res.redirect(`/groups/${group._id}/info`);
  } catch (error) {
    logger.error('Updating group picture failed', error);
    flash(req, 'error', 'Could not update the group picture.');
    res.redirect(`/groups/${req.params.id}/info`);
  }
};

exports.removeAvatar = async (req, res) => {
  const group = await loadManageable(req, res);
  if (!group) return;
  group.avatar = '';
  await group.save();
  flash(req, 'success', 'Group picture removed.');
  res.redirect(`/groups/${group._id}/info`);
};

exports.addMembers = async (req, res) => {
  try {
    const group = await loadManageable(req, res);
    if (!group) return;
    const people = await resolveNewMembers({
      identifiers: splitIdentifiers(req.body.members),
      ids: toArray(req.body.memberIds),
      adderId: req.session.user.id,
      exclude: group.members
    });
    if (!people.length) {
      flash(req, 'error', 'No one to add. Use a verified person\'s email or exact display name, and note that people already in the group are skipped.');
      return res.redirect(`/groups/${group._id}/info`);
    }
    const room = MAX_MEMBERS - group.members.length;
    if (room <= 0) {
      flash(req, 'error', `A group can have up to ${MAX_MEMBERS} members.`);
      return res.redirect(`/groups/${group._id}/info`);
    }
    const added = people.slice(0, room);
    added.forEach((user) => group.members.addToSet(user._id));
    await group.save();
    await systemNote(group._id, req.session.user.id, `added ${added.map((user) => user.name).join(', ')}.`);
    added.forEach((user) => notify(user._id, req.session.user.id, 'message', `added you to ${group.name}.`, undefined, undefined, req.session.user.name, `/groups/${group._id}`).catch(() => {}));
    flash(req, 'success', added.length < people.length ? `Added ${added.length}. The group is full at ${MAX_MEMBERS} members.` : `Added ${added.length} ${added.length === 1 ? 'person' : 'people'}.`);
    res.redirect(`/groups/${group._id}/info`);
  } catch (error) {
    logger.error('Adding group members failed', error);
    flash(req, 'error', 'Could not add members right now.');
    res.redirect(`/groups/${req.params.id}/info`);
  }
};

exports.removeMember = async (req, res) => {
  try {
    const group = await loadManageable(req, res);
    if (!group) return;
    const targetId = req.params.userId;
    const viewerId = req.session.user.id;
    if (!memberOf(group, targetId) || same(targetId, viewerId)) {
      flash(req, 'error', same(targetId, viewerId) ? 'Use "Leave group" to leave.' : 'That person is not in this group.');
      return res.redirect(`/groups/${group._id}/info`);
    }
    if (same(group.creator, targetId)) {
      flash(req, 'error', 'The group owner cannot be removed.');
      return res.redirect(`/groups/${group._id}/info`);
    }
    // Only the owner can remove another admin.
    if (isAdmin(group, targetId) && !same(group.creator, viewerId)) {
      flash(req, 'error', 'Only the group owner can remove an admin.');
      return res.redirect(`/groups/${group._id}/info`);
    }
    const target = await User.findById(targetId).select('name').lean();
    group.members.pull(targetId);
    group.admins.pull(targetId);
    await group.save();
    await systemNote(group._id, viewerId, `removed ${target?.name || 'a member'}.`);
    flash(req, 'success', `${target?.name || 'Member'} was removed.`);
    res.redirect(`/groups/${group._id}/info`);
  } catch (error) {
    logger.error('Removing group member failed', error);
    flash(req, 'error', 'Could not remove that member.');
    res.redirect(`/groups/${req.params.id}/info`);
  }
};

exports.toggleAdmin = async (req, res) => {
  try {
    const group = await loadManageable(req, res);
    if (!group) return;
    if (!same(group.creator, req.session.user.id)) {
      flash(req, 'error', 'Only the group owner can change admins.');
      return res.redirect(`/groups/${group._id}/info`);
    }
    const targetId = req.params.userId;
    if (!memberOf(group, targetId) || same(targetId, group.creator)) return res.redirect(`/groups/${group._id}/info`);
    const target = await User.findById(targetId).select('name').lean();
    if (isAdmin(group, targetId)) {
      group.admins.pull(targetId);
      await group.save();
      await systemNote(group._id, req.session.user.id, `removed ${target?.name || 'a member'} as admin.`);
    } else {
      group.admins.addToSet(targetId);
      await group.save();
      await systemNote(group._id, req.session.user.id, `made ${target?.name || 'a member'} an admin.`);
    }
    res.redirect(`/groups/${group._id}/info`);
  } catch (error) {
    logger.error('Changing group admin failed', error);
    flash(req, 'error', 'Could not change admins right now.');
    res.redirect(`/groups/${req.params.id}/info`);
  }
};

exports.leave = async (req, res) => {
  try {
    const group = await loadManageable(req, res, { adminOnly: false });
    if (!group) return;
    const userId = req.session.user.id;
    group.members.pull(userId);
    group.admins.pull(userId);
    if (!group.members.length) {
      await GroupMessage.deleteMany({ group: group._id });
      await GroupConversation.deleteOne({ _id: group._id });
      flash(req, 'success', 'You left the group. It was empty, so it was deleted.');
      return res.redirect('/groups');
    }
    if (same(group.creator, userId)) {
      // Hand ownership to the longest-standing admin, else the earliest member.
      const successor = group.admins[0] || group.members[0];
      group.creator = successor;
      group.admins.addToSet(successor);
    }
    await group.save();
    await systemNote(group._id, userId, 'left the group.');
    flash(req, 'success', 'You left the group.');
    res.redirect('/groups');
  } catch (error) {
    logger.error('Leaving group failed', error);
    flash(req, 'error', 'Could not leave the group right now.');
    res.redirect(`/groups/${req.params.id}/info`);
  }
};

// ---- invite link -----------------------------------------------------------

exports.createInvite = async (req, res) => {
  try {
    const group = await loadManageable(req, res);
    if (!group) return;
    // Creating always issues a fresh code, so this doubles as "reset link".
    group.inviteCode = crypto.randomBytes(12).toString('base64url');
    await group.save();
    flash(req, 'success', 'Invite link ready. Anyone with it can join, so share it carefully.');
    res.redirect(`/groups/${group._id}/info#invite`);
  } catch (error) {
    logger.error('Creating group invite failed', error);
    flash(req, 'error', 'Could not create an invite link.');
    res.redirect(`/groups/${req.params.id}/info`);
  }
};

exports.revokeInvite = async (req, res) => {
  const group = await loadManageable(req, res);
  if (!group) return;
  group.inviteCode = undefined;
  await group.save();
  flash(req, 'success', 'Invite link turned off. The old link no longer works.');
  res.redirect(`/groups/${group._id}/info#invite`);
};

async function findByInvite(code) {
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(String(code || ''))) return null;
  return GroupConversation.findOne({ inviteCode: code }).populate('members', 'name profilePicture').lean();
}

exports.joinPreview = async (req, res) => {
  try {
    const group = await findByInvite(req.params.code);
    if (!group) return res.status(404).render('pages/not-found', { title: 'Invite link is not valid' });
    if (memberOf(group, req.session.user.id)) return res.redirect(`/groups/${group._id}`);
    res.render('pages/group-join', { title: `Join ${group.name}`, pagePath: `/groups/join/${req.params.code}`, noIndex: true, group, code: req.params.code, full: group.members.length >= MAX_MEMBERS });
  } catch (error) {
    logger.error('Loading group invite failed', error);
    res.status(500).render('pages/not-found', { title: 'Crowdwide is having trouble' });
  }
};

exports.joinConfirm = async (req, res) => {
  try {
    const group = await GroupConversation.findOne({ inviteCode: String(req.params.code || '') });
    if (!group) return res.status(404).render('pages/not-found', { title: 'Invite link is not valid' });
    const userId = req.session.user.id;
    if (memberOf(group, userId)) return res.redirect(`/groups/${group._id}`);
    if (group.members.length >= MAX_MEMBERS) {
      flash(req, 'error', 'This group is full.');
      return res.redirect(`/groups/join/${req.params.code}`);
    }
    group.members.addToSet(userId);
    await group.save();
    await systemNote(group._id, userId, 'joined using the invite link.');
    res.redirect(`/groups/${group._id}`);
  } catch (error) {
    logger.error('Joining group failed', error);
    flash(req, 'error', 'Could not join that group right now.');
    res.redirect('/groups');
  }
};

exports.memberOf = memberOf;
exports.isAdmin = isAdmin;
exports.MAX_MEMBERS = MAX_MEMBERS;
