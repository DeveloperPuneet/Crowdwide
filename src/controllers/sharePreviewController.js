// Link previews for pages that need a login.
//
// Profile, community and invite links are shared on WhatsApp, X, LinkedIn and
// so on. Those apps fetch the link without a session, so they used to see the
// sign-in page. For visitors who are not signed in these routes now return a
// small public preview page (title, description, image) with sign-in / join
// buttons. Signed-in members fall straight through to the real page.
//
// Privacy rules: only what is already public is shown. Private communities and
// followers-only profiles get a generic preview that does not reveal a name.
const mongoose = require('mongoose');
const User = require('../models/User');
const Community = require('../models/Community');
const { preview } = require('../utils/textPreview');
const logger = require('../services/logger');

const GENERIC_DESCRIPTION = 'Crowdwide is a calmer social network for real discovery, thoughtful communities, and voices worth finding.';

function appBase(res) {
  return String(res.locals.appUrl || process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function absoluteImage(res, value) {
  if (!value) return undefined;
  if (/^https?:\/\//i.test(value)) return value;
  return value.startsWith('/') ? `${appBase(res)}${value}` : undefined;
}

function renderPreview(res, data) {
  return res.status(200).render('pages/share-preview', {
    noIndex: data.noIndex !== false,
    ...data
  });
}

async function profileData(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  const user = await User.findById(req.params.id).select('name bio profilePicture privacy isVerified following').lean();
  if (!user || !user.isVerified) return null;
  if (user.privacy !== 'public') {
    return { title: 'A Crowdwide profile', description: 'Sign in or join Crowdwide to see this profile.', heading: 'A Crowdwide profile', ctaLabel: 'View this profile' };
  }
  const followers = await User.countDocuments({ following: user._id });
  const description = user.bio ? preview(user.bio, 160) : `Follow ${user.name} on Crowdwide, a calmer social network for real discovery.`;
  return {
    title: `${user.name} on Crowdwide`,
    description,
    heading: user.name,
    subheading: `${followers.toLocaleString()} follower${followers === 1 ? '' : 's'}`,
    image: user.profilePicture || '',
    ogImage: absoluteImage(res, user.profilePicture),
    ogImageAlt: `${user.name}'s profile picture`,
    ogType: 'profile',
    ctaLabel: `Follow ${user.name}`
  };
}

async function communityData(req, res) {
  const community = await Community.findOne({ slug: String(req.params.slug || '').toLowerCase() })
    .select('name description isPrivate membersCount category coverImage avatarImage').lean();
  if (!community) return null;
  if (community.isPrivate) {
    return { title: 'A private Crowdwide community', description: 'This community is private. Sign in or join Crowdwide to request access.', heading: 'A private community', ctaLabel: 'Request access' };
  }
  const members = Number(community.membersCount || 0);
  const image = community.coverImage || community.avatarImage || '';
  return {
    title: `${community.name} · Community`,
    description: preview(community.description || `${community.name} is a community on Crowdwide.`, 160),
    heading: community.name,
    subheading: `${members.toLocaleString()} member${members === 1 ? '' : 's'}${community.category ? ` · ${community.category}` : ''}`,
    image: community.avatarImage || community.coverImage || '',
    ogImage: absoluteImage(res, image),
    ogImageAlt: `${community.name} community`,
    ogImageLarge: Boolean(community.coverImage),
    noIndex: false,
    ctaLabel: `Join ${community.name}`
  };
}

async function inviteData(req, res) {
  const community = await Community.findOne({ inviteCode: req.params.code, isPrivate: true }).select('name').lean();
  if (!community) return null;
  // The invite code is the only thing that grants access, so the preview stays
  // generic: it never reveals the name or description of a private community.
  return { title: "You're invited to a private community", description: 'Someone invited you to join a private community on Crowdwide. Sign in or create an account to accept.', heading: "You're invited", ctaLabel: 'Accept invite' };
}

async function groupInviteData() {
  return { title: "You're invited to a group chat", description: 'Someone invited you to a group chat on Crowdwide. Sign in or create an account to join.', heading: "You're invited", ctaLabel: 'Join the group' };
}

const BUILDERS = { profile: profileData, community: communityData, invite: inviteData, group: groupInviteData };

/** Route middleware: previews for signed-out visitors, passthrough for members. */
function visitorPreview(kind) {
  const build = BUILDERS[kind];
  return async (req, res, next) => {
    if (req.session?.user || req.method !== 'GET') return next();
    try {
      const data = await build(req, res);
      if (!data) return next(); // unknown link: keep the normal sign-in redirect
      return renderPreview(res, { ...data, pagePath: req.path, nextPath: req.path });
    } catch (error) {
      logger.warn('Share preview failed', { kind, route: req.path, error });
      return next();
    }
  };
}

module.exports = { visitorPreview };
