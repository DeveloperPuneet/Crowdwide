// Sharing a post *inside* Crowdwide (like Instagram's "send"): pick people
// and/or groups, optionally add a note, and the post lands in each chat as a
// preview card. Only this flow raises Post.sharesCount - copying the link or
// using the phone's share sheet never does.

const Post = require('../models/Post');
const User = require('../models/User');
const Message = require('../models/Message');
const GroupConversation = require('../models/GroupConversation');
const GroupMessage = require('../models/GroupMessage');
const PostShare = require('../models/PostShare');
const logger = require('../services/logger');
const { notify, canAccessPost } = require('./interactionController');
const { notifyMessage, memberOf } = require('./chatController');

const MAX_TARGETS = 10;
const TARGET_PATTERN = /^[ug]:[a-f\d]{24}$/i;
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function parseTargets(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(',');
  return Array.from(new Set(list.map((item) => String(item).trim()).filter((item) => TARGET_PATTERN.test(item)))).slice(0, MAX_TARGETS);
}

// People and groups the viewer can send to: recent chats first, then people
// they follow; groups they belong to. `q` filters by name.
exports.targets = async (req, res) => {
  try {
    const userId = String(req.session.user.id);
    const q = String(req.query.q || '').trim().slice(0, 40);
    const nameFilter = q ? { name: new RegExp(escapeRegex(q), 'i') } : {};
    const viewer = await User.findById(userId).select('following blockedUsers').lean();
    const blocked = (viewer?.blockedUsers || []).map(String);

    const recent = await Message.find({ $or: [{ sender: userId }, { recipient: userId }] }).sort({ _id: -1 }).limit(80).select('sender recipient').lean();
    const orderedIds = [];
    const remember = (id) => { const value = String(id); if (value !== userId && !orderedIds.includes(value)) orderedIds.push(value); };
    recent.forEach((message) => remember(String(message.sender) === userId ? message.recipient : message.sender));
    (viewer?.following || []).slice().reverse().slice(0, 60).forEach(remember);

    const [known, searched, groups] = await Promise.all([
      orderedIds.length ? User.find({ _id: { $in: orderedIds, $nin: blocked }, isVerified: true, ...nameFilter }).select('name profilePicture blockedUsers').lean() : [],
      q ? User.find({ _id: { $ne: userId, $nin: blocked }, isVerified: true, ...nameFilter }).limit(10).select('name profilePicture blockedUsers').lean() : [],
      GroupConversation.find({ members: userId, ...nameFilter }).sort({ updatedAt: -1 }).limit(20).select('name avatar members').lean()
    ]);
    const byId = new Map([...searched, ...known].map((user) => [String(user._id), user]));
    const rank = (id) => { const index = orderedIds.indexOf(String(id)); return index === -1 ? 999 : index; };
    const people = Array.from(byId.values())
      .filter((user) => !(user.blockedUsers || []).some((id) => String(id) === userId))
      .sort((a, b) => rank(a._id) - rank(b._id))
      .slice(0, 30)
      .map((user) => ({ id: `u:${user._id}`, name: user.name, avatar: user.profilePicture || '' }));
    res.json({
      people,
      groups: groups.map((group) => ({ id: `g:${group._id}`, name: group.name, avatar: group.avatar || '', members: group.members.length }))
    });
  } catch (error) {
    logger.error('Loading share targets failed', error);
    res.status(500).json({ people: [], groups: [], error: 'Could not load your chats.' });
  }
};

exports.send = async (req, res) => {
  try {
    const userId = String(req.session.user.id);
    const post = await Post.findById(req.params.id).select('author status community sharesCount');
    if (!post || post.status !== 'published' || !(await canAccessPost(post, userId))) return res.status(404).json({ ok: false, error: 'That post cannot be shared.' });
    const targets = parseTargets(req.body.targets);
    if (!targets.length) return res.status(400).json({ ok: false, error: 'Choose at least one person or group.' });
    const note = String(req.body.note || '').trim().slice(0, 500);
    const viewer = await User.findById(userId).select('blockedUsers').lean();

    let sent = 0;
    let newShares = 0;
    for (const target of targets) {
      const [kind, id] = target.split(':');
      let delivered = false;
      if (kind === 'u') {
        const recipient = await User.findById(id).select('_id isVerified blockedUsers').lean();
        const blocked = recipient && ((viewer?.blockedUsers || []).some((blockedId) => String(blockedId) === String(recipient._id)) || (recipient.blockedUsers || []).some((blockedId) => String(blockedId) === userId));
        if (recipient && recipient.isVerified && !blocked && String(recipient._id) !== userId) {
          await Message.create({ sender: userId, recipient: recipient._id, body: note, sharedPost: post._id });
          notifyMessage({ recipient: recipient._id, actor: userId, text: 'sent you a post.', actorName: req.session.user.name, url: `/messages/${userId}` }).catch((error) => logger.error('Share notification failed', error));
          delivered = true;
        }
      } else {
        const group = await GroupConversation.findById(id).select('members name');
        if (memberOf(group, userId)) {
          await GroupMessage.create({ group: group._id, sender: userId, body: note, sharedPost: post._id });
          await GroupConversation.updateOne({ _id: group._id }, { updatedAt: new Date() });
          Promise.all(group.members.filter((memberId) => String(memberId) !== userId).map((memberId) => notifyMessage({ recipient: memberId, actor: userId, text: `sent a post in ${group.name}.`, actorName: req.session.user.name, url: `/groups/${group._id}` })))
            .catch((error) => logger.error('Group share notification failed', error));
          delivered = true;
        }
      }
      if (!delivered) continue;
      sent += 1;
      try {
        await PostShare.create({ post: post._id, user: userId, targetType: kind === 'u' ? 'user' : 'group', target: id });
        newShares += 1;
      } catch (error) {
        if (error.code !== 11000) throw error; // already shared to this chat: still delivered, just not counted again
      }
    }
    if (!sent) return res.status(400).json({ ok: false, error: 'Nobody could receive that post.' });

    let shares = post.sharesCount || 0;
    if (newShares) {
      const updated = await Post.findByIdAndUpdate(post._id, { $inc: { sharesCount: newShares } }, { new: true });
      shares = updated?.sharesCount ?? shares + newShares;
      await notify(post.author, userId, 'comment', 'shared your post.', post._id, post.community, req.session.user.name);
    }
    res.json({ ok: true, sent, shares });
  } catch (error) {
    logger.error('Sending a shared post failed', error);
    res.status(500).json({ ok: false, error: 'Could not send that right now.' });
  }
};

exports.parseTargets = parseTargets;
