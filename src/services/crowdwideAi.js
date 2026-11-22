const mongoose = require('mongoose');
const Post = require('../models/Post');
const Comment = require('../models/Comment');
const User = require('../models/User');
const Community = require('../models/Community');
const { searchPublishedPosts } = require('./postSearch');
const { getHiddenAuthorIds, canSeeProfileDetails } = require('../utils/profilePrivacy');
const { getRestrictedCommunityIds } = require('../utils/communityPrivacy');

const MAX_RESULTS = 5;
const MAX_QUERY_LENGTH = 160;

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeSearchRegex(query) {
  const clean = String(query || '').trim().slice(0, MAX_QUERY_LENGTH);
  return clean ? new RegExp(escapeRegex(clean), 'i') : null;
}

function titleFromPrompt(prompt) {
  const normalized = String(prompt || '').replace(/\s+/g, ' ').trim();
  return normalized.length > 64 ? `${normalized.slice(0, 61)}...` : normalized || 'New conversation';
}

function parseActionRequest(prompt) {
  const text = String(prompt || '').trim();
  const create = /^(?:please\s+)?(?:publish|post|create)\s+(?:(?:this|the following)\s*)?(?:post)?\s*:\s*([\s\S]+)$/i.exec(text);
  if (create) return { kind: 'create_post', content: create[1].trim() };

  const edit = /^(?:please\s+)?edit\s+(?:my\s+)?post\s+([a-f\d]{24})\s+to\s*:\s*([\s\S]+)$/i.exec(text);
  if (edit) return { kind: 'edit_post', postId: edit[1], content: edit[2].trim() };

  const deletePost = /^(?:please\s+)?delete\s+(?:my\s+)?post\s+([a-f\d]{24})\s*\.?$/i.exec(text);
  if (deletePost) return { kind: 'delete_post', postId: deletePost[1] };
  return null;
}

async function getViewerContext(userId) {
  const viewer = await User.findById(userId)
    .select('following blockedUsers mutedUsers role')
    .lean();
  if (!viewer) {
    const error = new Error('Your account could not be found.');
    error.status = 401;
    throw error;
  }
  const [hiddenAuthors, restrictedCommunities] = await Promise.all([
    getHiddenAuthorIds(viewer._id, viewer.following || []),
    getRestrictedCommunityIds(viewer._id)
  ]);
  const excludedAuthors = [...new Set([
    ...(viewer.blockedUsers || []),
    ...(viewer.mutedUsers || []),
    ...hiddenAuthors
  ].map(String))];
  return {
    viewer,
    excludedAuthors,
    restrictedCommunities: restrictedCommunities.map(String),
    postFilter: {
      status: 'published',
      moderationStatus: { $ne: 'reported' },
      author: { $nin: excludedAuthors },
      community: { $nin: restrictedCommunities }
    }
  };
}

function toPostSource(post) {
  const author = post.author && typeof post.author === 'object' ? post.author : null;
  return {
    type: 'post',
    id: String(post._id),
    title: `${post.type === 'article' ? 'Article' : post.type === 'poll' ? 'Poll' : 'Post'}${author?.name ? ` by ${author.name}` : ''}${post.community?.name ? ` · ${post.community.name}` : ''}`,
    url: `/posts/${post._id}`,
    excerpt: String(post.body || '').slice(0, 1200),
    createdAt: post.createdAt
  };
}

function toUserSource(user) {
  return {
    type: 'profile',
    id: String(user._id),
    title: user.name || 'Crowdwide member',
    url: `/u/${user._id}`,
    excerpt: String(user.bio || '').slice(0, 800),
    createdAt: user.createdAt
  };
}

function toCommentSource(comment) {
  const postId = comment.post?._id || comment.post;
  return {
    type: 'comment',
    id: String(comment._id),
    title: `Comment${comment.author?.name ? ` by ${comment.author.name}` : ''}`,
    url: `/posts/${postId}#comment-${comment._id}`,
    excerpt: String(comment.body || '').slice(0, 800),
    createdAt: comment.createdAt
  };
}

function toContext(source) {
  return {
    type: source.type,
    title: source.title,
    text: source.excerpt,
    url: source.url
  };
}

function sourceList(sources) {
  const unique = new Map();
  sources.forEach((source) => unique.set(`${source.type}:${source.id}`, source));
  return [...unique.values()].slice(0, 8);
}

async function findPosts(query, viewerContext, { recent = false, authorId = null, limit = MAX_RESULTS } = {}) {
  const { postFilter, excludedAuthors, restrictedCommunities } = viewerContext;
  const filter = {
    ...postFilter,
    ...(authorId ? { author: { $in: [authorId], $nin: postFilter.author.$nin } } : {})
  };
  if (recent) {
    return Post.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .populate('author', 'name username profilePicture')
      .populate('community', 'name slug')
      .select('body type hashtags author community createdAt commentsCount')
      .lean();
  }
  const regex = makeSearchRegex(query);
  if (!regex) return [];
  const indexedIds = await searchPublishedPosts({
    query: String(query).slice(0, MAX_QUERY_LENGTH),
    limit: Math.min(limit * 3, 15),
    filters: {
      blockedAuthors: excludedAuthors,
      restrictedCommunities,
      sort: 'relevance'
    }
  });
  if (indexedIds !== null) {
    if (!indexedIds.length) return [];
    const posts = await Post.find({ ...filter, _id: { $in: indexedIds } })
      .limit(limit)
      .populate('author', 'name username profilePicture')
      .populate('community', 'name slug')
      .select('body type hashtags author community createdAt commentsCount')
      .lean();
    const rank = new Map(indexedIds.map((id, index) => [String(id), index]));
    return posts.sort((left, right) => (rank.get(String(left._id)) ?? limit) - (rank.get(String(right._id)) ?? limit));
  }
  return Post.find({
    ...filter,
    $or: [{ body: regex }, { hashtags: regex }]
  })
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit)
    .populate('author', 'name username profilePicture')
    .populate('community', 'name slug')
    .select('body type hashtags author community createdAt commentsCount')
    .lean();
}

async function searchUsers(query, viewerContext) {
  const searchTerm = String(query || '').trim().replace(/^@/, '');
  const regex = makeSearchRegex(searchTerm);
  if (!regex) return [];
  const users = await User.find({
    isVerified: true,
    _id: { $nin: viewerContext.excludedAuthors },
    $or: [{ name: regex }, { username: regex }, { bio: regex }, { hashtags: regex }]
  })
    .select('name username bio profilePicture privacy createdAt')
    .sort({ createdAt: -1 })
    .limit(MAX_RESULTS)
    .lean();
  return users.filter((user) => canSeeProfileDetails({
    profileUser: user,
    viewerId: viewerContext.viewer._id,
    viewerFollowing: viewerContext.viewer.following || [],
    viewerRole: viewerContext.viewer.role
  })).map(toUserSource);
}

function extractSearchQuery(query) {
  return String(query || '')
    .trim()
    .replace(/^(?:hey\s+)?(?:crowdwide\s+ai[, ]*)?(?:please\s+)?(?:what are (?:users|people) saying about|what are people discussing about|(?:latest|recent|newest)\s+(?:public\s+)?(?:posts?|discussions?|comments?)\s+(?:about|on|for)|search (?:posts|users|comments|communities) (?:for|about|named|called)|find (?:posts|users|comments|communities|profiles|members|people|users?) (?:for|about|named|called|of)|who is|find|search for|look up|show me|show|tell me about|comments about|posts about|discussions about|people named|users named)\s+/i, '')
    .replace(/[?!]+$/, '')
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
}

async function searchComments(query, viewerContext, { postId = null } = {}) {
  const regex = makeSearchRegex(query);
  if (!postId && !regex) return [];
  let visiblePostIds;
  if (postId && mongoose.isValidObjectId(postId)) {
    const visiblePost = await getPostById(postId, viewerContext);
    visiblePostIds = visiblePost ? [visiblePost._id] : [];
  } else {
    const candidates = await Post.find(viewerContext.postFilter)
      .sort({ createdAt: -1 })
      .limit(80)
      .select('_id')
      .lean();
    visiblePostIds = candidates.map((post) => post._id);
  }
  if (!visiblePostIds.length) return [];
  const comments = await Comment.find({
    post: { $in: visiblePostIds },
    author: { $nin: viewerContext.excludedAuthors },
    ...(regex ? { body: regex } : {})
  })
    .sort({ createdAt: -1 })
    .limit(MAX_RESULTS)
    .populate('author', 'name username')
    .populate({ path: 'post', match: viewerContext.postFilter, select: '_id' })
    .lean();
  return comments.filter((comment) => comment.post).map(toCommentSource);
}

async function getPostById(postId, viewerContext) {
  if (!mongoose.isValidObjectId(postId)) return null;
  return Post.findOne({ _id: postId, ...viewerContext.postFilter })
    .populate('author', 'name username profilePicture')
    .populate('community', 'name slug')
    .select('body type hashtags author community createdAt commentsCount')
    .lean();
}

async function getProfileActivity(query, viewerContext) {
  const profileMatch = /(?:@([a-z0-9_]{3,24})|\/u\/([a-f\d]{24})|\b([a-f\d]{24})\b)/i.exec(query);
  let profile = null;
  if (profileMatch?.[1]) {
    profile = await User.findOne({ username: profileMatch[1].toLowerCase(), isVerified: true })
      .select('name username bio profilePicture privacy following createdAt')
      .lean();
  } else if (profileMatch?.[2] || profileMatch?.[3]) {
    profile = await User.findOne({ _id: profileMatch[2] || profileMatch[3], isVerified: true })
      .select('name username bio profilePicture privacy following createdAt')
      .lean();
  } else {
    const profileName = query
      .replace(/.*?\b(?:by|from|for|user|member|has)\s+/i, '')
      .replace(/\s+(?:posted|posts?|activity)\b.*$/i, '')
      .trim();
    const regex = makeSearchRegex(profileName);
    if (!regex) return [];
    profile = await User.findOne({
      isVerified: true,
      $or: [{ username: regex }, { name: regex }]
    }).select('name username bio profilePicture privacy following createdAt').lean();
  }
  if (!profile) return [];
  if (viewerContext.excludedAuthors.includes(String(profile._id))) return [];
  if (!canSeeProfileDetails({
    profileUser: profile,
    viewerId: viewerContext.viewer._id,
    viewerFollowing: viewerContext.viewer.following || [],
    viewerRole: viewerContext.viewer.role
  })) return [];
  const posts = await findPosts('', viewerContext, { recent: true, authorId: profile._id, limit: 4 });
  return [toUserSource(profile), ...posts.map(toPostSource)];
}

async function getRecentDiscussions(viewerContext) {
  const posts = await findPosts('', viewerContext, { recent: true, limit: MAX_RESULTS });
  if (!posts.length) return [];
  const comments = await Comment.find({
    post: { $in: posts.map((post) => post._id) },
    author: { $nin: viewerContext.excludedAuthors }
  })
    .sort({ createdAt: -1 })
    .limit(8)
    .populate('author', 'name username')
    .populate({ path: 'post', match: viewerContext.postFilter, select: '_id' })
    .lean();
  return [
    ...posts.map(toPostSource),
    ...comments.filter((comment) => comment.post).slice(0, 5).map(toCommentSource)
  ];
}

async function getTrendingTopics(viewerContext) {
  const rows = await Post.aggregate([
    { $match: { ...viewerContext.postFilter, createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }, hashtags: { $exists: true, $ne: [] } } },
    { $unwind: '$hashtags' },
    { $group: { _id: '$hashtags', posts: { $sum: 1 }, latest: { $max: '$createdAt' } } },
    { $sort: { posts: -1, latest: -1 } },
    { $limit: 8 },
    { $project: { _id: 0, tag: '$_id', posts: 1, latest: 1 } }
  ]);
  return rows.map((row) => ({
    type: 'topic',
    id: String(row.tag),
    title: `#${row.tag}`,
    url: `/search?q=${encodeURIComponent(`#${row.tag}`)}`,
    excerpt: `${row.posts} recent public ${row.posts === 1 ? 'post' : 'posts'}`,
    createdAt: row.latest
  }));
}

async function searchCommunities(query) {
  const regex = makeSearchRegex(extractSearchQuery(query));
  if (!regex) return [];
  const communities = await Community.find({
    isPrivate: false,
    $or: [{ name: regex }, { description: regex }, { category: regex }, { hashtags: regex }]
  })
    .select('name slug description category hashtags createdAt')
    .sort({ name: 1 })
    .limit(MAX_RESULTS)
    .lean();
  return communities.map((community) => ({
    type: 'community',
    id: String(community._id),
    title: community.name,
    url: `/communities/${community.slug}`,
    excerpt: `${community.category || 'general'} · ${String(community.description || '').slice(0, 1000)}${community.hashtags?.length ? ` · Tags: ${community.hashtags.slice(0, 5).map((tag) => `#${tag}`).join(', ')}` : ''}`,
    createdAt: community.createdAt
  }));
}

async function getStatistics(viewerContext) {
  const [posts, members, communities] = await Promise.all([
    Post.countDocuments(viewerContext.postFilter),
    User.countDocuments({ isVerified: true, privacy: 'public' }),
    Community.countDocuments({ isPrivate: false })
  ]);
  return [{
    type: 'statistics',
    id: 'public-statistics',
    title: 'Crowdwide public statistics',
    url: '/posts',
    excerpt: `${posts.toLocaleString()} published posts visible to you, ${members.toLocaleString()} verified public profiles, and ${communities.toLocaleString()} public communities.`
  }];
}

function selectTool(query) {
  const normalized = String(query || '').toLowerCase();
  if (/^(?:please\s+)?(?:publish|post|create)\s+(?:(?:this|the following)\s*)?(?:post)?\s*:/i.test(normalized) ||
      /^(?:please\s+)?edit\s+(?:my\s+)?post\s+[a-f\d]{24}\s+to\s*:/i.test(normalized) ||
      /^(?:please\s+)?delete\s+(?:my\s+)?post\s+[a-f\d]{24}\s*\.?$/i.test(normalized)) return 'action';
  if (/\b(statistics|how many|count of|site stats)\b/.test(normalized)) return 'statistics';
  if (/\b(trending|popular topics|trending topics|hashtags)\b/.test(normalized)) return 'trending';
  if (/\b(communities|community|categories|category)\b/.test(normalized)) return 'communities';
  if (/\b(activity|posts by|posts from|profile of|what has .+ posted)\b/.test(normalized)) return 'user_activity';
  if (/\b(users|people|members|profiles|who is)\b/.test(normalized) && !/\b(comments?|saying|discussing|feature)\b/.test(normalized)) return 'users';
  if (/\b(comments?|what are users saying|opinions|talking about|discussion replies)\b/.test(normalized) ||
      /\bdiscussions?\s+(?:about|on|for)\s+(?!crowdwide\b)/.test(normalized)) return 'comments';
  if (/\b(?:summari[sz]e|details|discussion)\b/.test(normalized) && /\b[a-f\d]{24}\b/.test(normalized)) return 'post_details';
  if (/\b(latest|recent|newest|happening|discussions|what is going on)\b/.test(normalized)) return 'recent';
  return 'posts';
}

async function executeCrowdwideTools({ query, userId }) {
  const viewerContext = await getViewerContext(userId);
  const action = parseActionRequest(query);
  if (action) return { tool: 'action', action, sources: [], context: [], summary: '' };
  const tool = selectTool(query);
  let sources = [];
  let summary = '';
  if (tool === 'statistics') {
    sources = await getStatistics(viewerContext);
  } else if (tool === 'trending') {
    sources = await getTrendingTopics(viewerContext);
  } else if (tool === 'recent') {
    sources = await getRecentDiscussions(viewerContext);
  } else if (tool === 'users') {
    sources = await searchUsers(extractSearchQuery(query), viewerContext);
  } else if (tool === 'communities') {
    sources = await searchCommunities(query);
  } else if (tool === 'user_activity') {
    sources = await getProfileActivity(query, viewerContext);
  } else if (tool === 'comments') {
    const topic = extractSearchQuery(query);
    sources = [
      ...(await findPosts(topic, viewerContext)).map(toPostSource),
      ...(await searchComments(topic, viewerContext))
    ];
  } else if (tool === 'post_details') {
    const id = (String(query).match(/\b[a-f\d]{24}\b/i) || [])[0];
    const post = id && await getPostById(id, viewerContext);
    if (post) sources = [toPostSource(post), ...(await searchComments('', viewerContext, { postId: String(post._id) }))];
  } else {
    sources = (await findPosts(extractSearchQuery(query), viewerContext)).map(toPostSource);
  }
  sources = sourceList(sources);
  if (tool === 'statistics') summary = sources[0]?.excerpt || '';
  else if (tool === 'trending') summary = sources.length ? `Crowdwide's most-used topics in the last seven days are ${sources.map((source) => `${source.title} (${source.excerpt.split(' · ')[0]})`).join(', ')}.` : 'No public hashtags have enough recent posts to show a trend.';
  else if (tool === 'recent') summary = sources.length ? 'Here are the newest public posts and replies I could retrieve.' : 'There are no recent public discussions available to show.';
  else if (tool === 'users') summary = sources.length ? 'Here are matching verified profiles and their public profile details.' : 'I could not find a matching verified profile.';
  else if (tool === 'communities') summary = sources.length ? 'Here are matching public Crowdwide communities and categories.' : 'I could not find a matching public community or category.';
  else if (tool === 'user_activity') summary = sources.length > 1 ? `Here is recent activity visible for ${sources[0].title}.` : 'I could not find a matching profile with activity you are allowed to view.';
  else if (tool === 'comments') summary = sources.length ? 'Here are matching replies from discussions visible to you.' : 'I could not find matching comments in discussions visible to you.';
  else if (tool === 'post_details') summary = sources.length ? 'Here is the post and relevant discussion content I could retrieve.' : 'That post is unavailable, private, or not visible to your account.';
  else summary = sources.length ? `I found ${sources.length} relevant public post${sources.length === 1 ? '' : 's'} visible to you.` : 'I could not find a matching public post visible to your account.';
  return { tool, sources, context: sources.map(toContext), summary };
}

function buildFallbackResponse(result) {
  if (result.action) return result.actionMessage || 'I can prepare that change, but nothing will happen until you confirm it.';
  const { summary, sources = [] } = result;
  if (!sources.length) return `${summary}\n\nI only report information I can verify from Crowdwide data; try a different search phrase or ask about a specific post or profile.`;
  const entries = sources.slice(0, 5).map((source, index) => {
    const excerpt = source.excerpt ? ` — ${source.excerpt.replace(/\s+/g, ' ').trim()}` : '';
    return `${index + 1}. **${source.title}**${excerpt} [${index + 1}](${source.url})`;
  });
  return `${summary}\n\n${entries.join('\n')}\n\nThis is a search-based summary, not generated by a language model.`;
}

module.exports = {
  MAX_RESULTS,
  buildFallbackResponse,
  executeCrowdwideTools,
  parseActionRequest,
  extractSearchQuery,
  selectTool,
  titleFromPrompt
};
