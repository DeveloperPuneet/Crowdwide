// First-time onboarding: pick interests, follow a few people, join a few
// communities. Shown once to every account that has neither finished nor
// skipped it (so existing members see it too), and reachable any time from the
// menu. Every step is an ordinary form post, so it works without JavaScript.
const mongoose = require('mongoose');
const User = require('../models/User');
const Community = require('../models/Community');
const discovery = require('../services/discovery');
const { refreshPersonalization } = require('../services/feedService');
const { rewardWavesForAction } = require('../services/waves');
const { notify } = require('./interactionController');
const { landingPath } = require('./authController');
const { parseHashtagList } = require('../utils/hashtags');
const { ONBOARDING_INTERESTS, INTEREST_VALUES, categoriesForInterests } = require('../utils/onboardingInterests');
const logger = require('../services/logger');

const MAX_FOLLOWS = 20;
const MAX_JOINS = 10;
const STEPS = ['Interests', 'People', 'Communities', 'All set'];

const asArray = (value) => (Array.isArray(value) ? value : value === undefined || value === '' ? [] : [value]);
const validIds = (value, max, exclude = []) => {
  const blocked = new Set(exclude.map(String));
  return Array.from(new Set(asArray(value).map(String)))
    .filter((id) => mongoose.isValidObjectId(id) && !blocked.has(id))
    .slice(0, max);
};
const count = (value) => Math.min(99, Math.max(0, parseInt(value, 10) || 0));

/** Redirects members who have not seen onboarding to it (checked once per session). */
async function onboardingGate(req, res, next) {
  if (req.method !== 'GET' || req.session.onboardingChecked) return next();
  try {
    const user = await User.findById(req.session.user.id).select('onboardingCompletedAt onboardingSkippedAt').lean();
    if (user && !user.onboardingCompletedAt && !user.onboardingSkippedAt) return res.redirect('/welcome');
    req.session.onboardingChecked = true;
  } catch (error) {
    logger.warn('Onboarding check failed', error);
  }
  return next();
}

async function suggestPeople(user) {
  const exclude = [user._id, ...(user.following || []), ...(user.blockedUsers || [])];
  const tags = user.hashtags || [];
  const [common, trending, joiners] = await Promise.all([
    discovery.getCommonInterestPeople(tags, exclude, 8),
    discovery.getTrendingCreators(exclude, 8),
    discovery.getNewJoiners(exclude.map(String).map((id) => new mongoose.Types.ObjectId(id)), 8)
  ]);
  const seen = new Set();
  const out = [];
  const add = (people, reason) => {
    for (const person of people) {
      const id = String(person._id);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        _id: person._id,
        name: person.name,
        bio: person.bio || '',
        profilePicture: person.profilePicture || '',
        reason: reason(person)
      });
    }
  };
  add(common, (person) => (person.sharedTags?.length ? `Also into ${person.sharedTags.map((tag) => `#${tag}`).join(', ')}` : 'Shares your interests'));
  add(trending, () => 'Popular this week');
  add(joiners, () => 'New on Crowdwide');
  return out.slice(0, 12);
}

async function suggestCommunities(user) {
  const joined = (user.joinedCommunities || []).map(String);
  const tags = user.hashtags || [];
  const categories = new Set(categoriesForInterests(tags.filter((tag) => INTEREST_VALUES.has(tag))));
  const rows = await Community.find({
    isPrivate: false,
    owner: { $ne: user._id },
    members: { $ne: user._id },
    _id: { $nin: joined }
  }).select('name slug description category hashtags membersCount avatarImage').sort({ membersCount: -1, createdAt: -1 }).limit(60).lean();
  return rows
    .map((community) => {
      const overlap = (community.hashtags || []).filter((tag) => tags.includes(tag)).length;
      const matches = overlap > 0 || categories.has(community.category);
      return { ...community, matches, score: overlap * 2 + (categories.has(community.category) ? 1 : 0) };
    })
    .sort((a, b) => b.score - a.score || (b.membersCount || 0) - (a.membersCount || 0))
    .slice(0, 10);
}

exports.page = async (req, res) => {
  const step = Math.min(4, Math.max(1, parseInt(req.query.step, 10) || 1));
  const user = await User.findById(req.session.user.id).select('hashtags following joinedCommunities blockedUsers').lean();
  const tags = user.hashtags || [];
  const data = {
    title: 'Welcome to Crowdwide',
    pagePath: '/welcome',
    noIndex: true,
    step,
    steps: STEPS,
    interests: ONBOARDING_INTERESTS,
    selectedInterests: tags.filter((tag) => INTEREST_VALUES.has(tag)),
    extraInterests: tags.filter((tag) => !INTEREST_VALUES.has(tag)).map((tag) => `#${tag}`).join(' '),
    people: [],
    communities: [],
    followed: count(req.query.followed),
    joined: count(req.query.joined)
  };
  if (step === 2) data.people = await suggestPeople(user);
  if (step === 3) data.communities = await suggestCommunities(user);
  res.render('pages/onboarding', data);
};

exports.saveInterests = async (req, res) => {
  const selected = asArray(req.body.interests).map(String).filter((value) => INTEREST_VALUES.has(value));
  const extra = parseHashtagList(req.body.extraInterests || '');
  const user = await User.findById(req.session.user.id).select('hashtags');
  // Keep tags the member added themselves; replace only the topic chips.
  const custom = (user.hashtags || []).filter((tag) => !INTEREST_VALUES.has(tag));
  user.hashtags = Array.from(new Set([...selected, ...extra, ...custom])).slice(0, 15);
  await user.save();
  refreshPersonalization(user._id);
  res.redirect('/welcome?step=2');
};

exports.follow = async (req, res) => {
  const userId = req.session.user.id;
  const user = await User.findById(userId).select('name following');
  const ids = validIds(req.body.follow, MAX_FOLLOWS, [userId, ...user.following]);
  let followed = 0;
  if (ids.length) {
    const targets = await User.find({ _id: { $in: ids }, isVerified: true }).select('_id blockedUsers').lean();
    const allowed = targets.filter((target) => !(target.blockedUsers || []).some((id) => String(id) === String(userId)));
    if (allowed.length) {
      await User.updateOne({ _id: userId }, { $addToSet: { following: { $each: allowed.map((target) => target._id) } } });
      followed = allowed.length;
      for (const target of allowed) {
        notify(target._id, user._id, 'follow', 'started following you.', undefined, undefined, user.name)
          .catch((error) => logger.warn('Follow notification from onboarding failed', error));
      }
      refreshPersonalization(userId);
    }
  }
  res.redirect(`/welcome?step=3&followed=${followed}`);
};

exports.joinCommunities = async (req, res) => {
  const userId = req.session.user.id;
  const ids = validIds(req.body.communities, MAX_JOINS);
  let joined = 0;
  for (const id of ids) {
    try {
      const community = await Community.findOneAndUpdate(
        { _id: id, isPrivate: false, members: { $ne: userId } },
        { $addToSet: { members: userId }, $push: { memberRoles: { user: userId, role: 'member' } } },
        { new: true }
      ).select('_id');
      if (!community) continue;
      await Community.updateOne({ _id: community._id }, [{ $set: { membersCount: { $size: '$members' } } }]);
      await User.updateOne({ _id: userId }, { $addToSet: { joinedCommunities: community._id } });
      rewardWavesForAction({ userId, action: 'communityJoin', referenceType: 'community', referenceId: community._id })
        .catch((error) => logger.warn('Could not award Waves for joining a community during onboarding', error));
      joined += 1;
    } catch (error) {
      logger.warn('Onboarding community join failed', { communityId: id, error });
    }
  }
  if (joined) refreshPersonalization(userId);
  await User.updateOne({ _id: userId }, { $set: { onboardingCompletedAt: new Date() }, $unset: { onboardingSkippedAt: 1 } });
  req.session.onboardingChecked = true;
  res.redirect(`/welcome?step=4&followed=${count(req.body.followed)}&joined=${joined}`);
};

exports.finish = async (req, res) => {
  await User.updateOne({ _id: req.session.user.id, onboardingCompletedAt: { $exists: false } }, { $set: { onboardingCompletedAt: new Date() } });
  req.session.onboardingChecked = true;
  res.redirect(landingPath(req));
};

exports.skip = async (req, res) => {
  await User.updateOne({ _id: req.session.user.id, onboardingCompletedAt: { $exists: false } }, { $set: { onboardingSkippedAt: new Date() } });
  req.session.onboardingChecked = true;
  res.redirect(landingPath(req));
};

exports.onboardingGate = onboardingGate;
