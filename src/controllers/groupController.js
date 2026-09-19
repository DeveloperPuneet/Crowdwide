const GroupConversation = require('../models/GroupConversation');
const GroupMessage = require('../models/GroupMessage');
const User = require('../models/User');
const logger = require('../services/logger');
const { notify } = require('./interactionController');

function memberOf(group, userId) {
  // group.members may be raw ObjectIds (unpopulated queries) or populated
  // user documents (e.g. thread()'s .populate('members', ...)) -- handle both.
  return group?.members?.some((member) => String(member?._id || member) === String(userId));
}

exports.list = async (req, res) => {
  try {
    const groups = await GroupConversation.find({ members: req.session.user.id })
      .sort({ updatedAt: -1 }).populate('members', 'name profilePicture').lean();
    res.render('pages/groups', { title: 'Group conversations', pagePath: '/groups', noIndex: true, groups });
  } catch (error) {
    logger.error('Loading group conversations failed', error);
    res.status(500).render('pages/not-found', { title: 'Crowdwide is having trouble' });
  }
};

exports.create = async (req, res) => {
  try {
    const name = req.body.name?.trim();
    const identifiers = String(req.body.members || '').split(/[\s,]+/).map((value) => value.trim().toLowerCase()).filter(Boolean).slice(0, 19);
    if (!name || name.length > 80) {
      req.session.flash = { type: 'error', message: 'Give the group a name.' };
      return res.redirect('/groups');
    }
    const users = await Promise.all(identifiers.map((identifier) => User.findOne({ isVerified: true, $or: [{ email: identifier }, { name: new RegExp(`^${identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }] }).select('_id').lean()));
    const members = Array.from(new Set([req.session.user.id, ...users.filter(Boolean).map((user) => String(user._id))]));
    if (members.length < 2) {
      req.session.flash = { type: 'error', message: 'Add at least one verified member by email or display name.' };
      return res.redirect('/groups');
    }
    const group = await GroupConversation.create({ name, creator: req.session.user.id, members });
    res.redirect(`/groups/${group._id}`);
  } catch (error) {
    logger.error('Creating group conversation failed', error);
    req.session.flash = { type: 'error', message: 'That group could not be created.' };
    res.redirect('/groups');
  }
};

exports.thread = async (req, res) => {
  try {
    const group = await GroupConversation.findById(req.params.id).populate('members', 'name profilePicture').lean();
    if (!group || !memberOf(group, req.session.user.id)) return res.status(404).render('pages/not-found', { title: 'Group not found' });
    const messages = await GroupMessage.find({ group: group._id }).sort({ createdAt: 1 }).limit(200).populate('sender', 'name profilePicture').lean();
    res.render('pages/group-thread', { title: group.name, pagePath: `/groups/${group._id}`, noIndex: true, group, messages });
  } catch (error) {
    logger.error('Loading group thread failed', error);
    res.status(500).render('pages/not-found', { title: 'Crowdwide is having trouble' });
  }
};

exports.send = async (req, res) => {
  try {
    const group = await GroupConversation.findById(req.params.id).select('members name');
    const body = req.body.body?.trim();
    if (!memberOf(group, req.session.user.id) || !body || body.length > 2000) {
      req.session.flash = { type: 'error', message: 'That message could not be sent.' };
      return res.redirect(`/groups/${req.params.id}`);
    }
    await GroupMessage.create({ group: group._id, sender: req.session.user.id, body });
    await GroupConversation.updateOne({ _id: group._id }, { updatedAt: new Date() });
    const otherMemberIds = group.members.filter((id) => String(id) !== String(req.session.user.id));
    await Promise.all(otherMemberIds.map((memberId) => notify(memberId, req.session.user.id, 'message', `sent a message in ${group.name}.`, undefined, undefined, req.session.user.name, `/groups/${group._id}`)));
    res.redirect(`/groups/${req.params.id}`);
  } catch (error) {
    logger.error('Sending group message failed', error);
    req.session.flash = { type: 'error', message: 'That message could not be sent.' };
    res.redirect(`/groups/${req.params.id}`);
  }
};
