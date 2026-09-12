const User = require('../models/User');
const Post = require('../models/Post');
const Community = require('../models/Community');
const { createSignedUpload, createImageThumbnail } = require('../services/storage');
const { uploadBuffer, streamFile, mediaUrl, clusterStatus } = require('../services/storageCluster');
const Comment = require('../models/Comment');
const { extractHashtags, parseHashtagList } = require('../utils/hashtags');
const { getViralPosts, getPopularPeople, getTrendingHashtags } = require('../services/discovery');
const { notifyMentionedUsers } = require('../services/mentions');

async function getLiveStats() {
	if (!User.db.readyState) {
		return { members: 0, posts: 0, communities: 0, communitiesAreLive: false, topCommunities: [] };
	}

	const [members, posts, communities, topCommunities] = await Promise.all([
		User.countDocuments(),
		Post.countDocuments(),
		Community.countDocuments(),
		Community.find().sort({ membersCount: -1, createdAt: -1 }).limit(3).lean()
	]);

	return {
		members,
		posts,
		communities,
		communitiesAreLive: communities > 0,
		topCommunities: topCommunities.map((community) => ({
			name: community.name,
			slug: community.slug,
			members: community.membersCount || 0,
			description: community.description
		}))
	};
}

exports.home = async (req, res) => {
	try {
		const stats = await getLiveStats();
		const [viralPosts, popularPeople] = await Promise.all([getViralPosts(4), getPopularPeople(4)]);
		res.render('pages/home', {
			title: 'A fair chance at discovery',
			description: 'Crowdwide gives every voice a fair chance at discovery through thoughtful communities and real conversation.',
			pagePath: '/',
			stats,
			viralPosts,
			popularPeople,
			structuredData: {
				'@context': 'https://schema.org',
				'@type': 'WebSite',
				name: 'Crowdwide',
				url: process.env.APP_URL || 'http://localhost:3000',
				description: 'A social network for real discovery.'
			}
		});
	} catch (error) {
		console.error('Unable to load live homepage stats:', error.message);
		res.render('pages/home', { title: 'A fair chance at discovery', pagePath: '/', stats: { members: 0, posts: 0, communities: 0, communitiesAreLive: false, topCommunities: [] }, viralPosts: [], popularPeople: [] });
	}
};

async function populatePosts(posts) {
	const populated = await Post.populate(posts, [
		{ path: 'author', select: 'name createdAt profilePicture' },
		{ path: 'community', select: 'name slug membersCount' },
		{ path: 'quotedPost', select: 'body author', populate: { path: 'author', select: 'name profilePicture' } },
		{ path: 'replyTo', select: 'body author', populate: { path: 'author', select: 'name profilePicture' } }
	]);
	const comments = await Comment.find({ post: { $in: posts.map((post) => post._id) } }).sort({ createdAt: 1 }).limit(200).populate('author', 'name').lean();
	return populated.map((post) => ({ ...post, comments: comments.filter((comment) => String(comment.post) === String(post._id)) }));
}

async function buildFeed(user, mode) {
	const joinedIds = user.joinedCommunities || [];
	const followingIds = (user.following || []).map(String);
	if (mode === 'personalized') {
		const likedTags = await Post.find({ likes: user._id, status: 'published' }).distinct('hashtags');
		const personalizedFilter = { status: 'published', $or: [{ community: { $in: joinedIds } }, { hashtags: { $in: likedTags } }] };
		const ownPosts = await Post.find({ author: user._id, status: { $in: ['draft', 'scheduled', 'published', 'pending'] } }).sort({ createdAt: -1 }).limit(6).lean();
		const relevantPosts = await Post.find(personalizedFilter).sort({ createdAt: -1 }).limit(30).lean();
		const unique = new Map([...ownPosts, ...relevantPosts].map((post) => [String(post._id), post]));
		return { posts: await populatePosts(Array.from(unique.values())), label: 'Personalized feed', note: joinedIds.length || likedTags.length ? 'Posts from your communities and topics related to what you like.' : 'Like a post or join a community to shape this feed.' };
	}

	const recentCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
	// A network doesn't stop at direct follows: pull in a slice of the wider
	// graph too (people your follows follow, and people who follow your
	// followers) so the feed can surface likely-relevant strangers, not just
	// your existing connections.
	const [followingOfFollowing, followersOfFollowers, followedPosts, newPosts, largeCommunities, viralPosts, recentPosts, ownPosts] = await Promise.all([
		followingIds.length ? User.find({ _id: { $in: followingIds } }).distinct('following') : Promise.resolve([]),
		User.find({ following: user._id }).distinct('_id').then((followers) => (followers.length ? User.find({ following: { $in: followers } }).distinct('_id') : [])),
		followingIds.length ? Post.find({ author: { $in: followingIds }, status: 'published' }).sort({ createdAt: -1 }).limit(10).lean() : Promise.resolve([]),
		Post.find({ status: 'published', $or: [{ createdAt: { $gte: recentCutoff } }, { community: { $exists: false } }] }).sort({ createdAt: -1 }).limit(20).lean(),
		Community.find().sort({ membersCount: -1 }).limit(20).select('_id').lean(),
		Post.aggregate([{ $match: { status: 'published' } }, { $addFields: { likesTotal: { $size: { $ifNull: ['$likes', []] } } } }, { $sort: { likesTotal: -1, createdAt: -1 } }, { $limit: 20 }]),
		Post.find({ status: 'published' }).sort({ createdAt: -1 }).limit(30).lean()
		, Post.find({ author: user._id, status: { $in: ['draft', 'scheduled', 'published', 'pending'] } }).sort({ createdAt: -1 }).limit(6).lean()
	]);
	const extendedNetworkIds = Array.from(new Set([...followingOfFollowing, ...followersOfFollowers].map(String)))
		.filter((id) => id !== String(user._id) && !followingIds.includes(id));
	const extendedPosts = extendedNetworkIds.length ? await Post.find({ author: { $in: extendedNetworkIds }, status: 'published' }).sort({ createdAt: -1 }).limit(6).lean() : [];
	const largeIds = largeCommunities.map((community) => community._id);
	const largePosts = await Post.find({ community: { $in: largeIds }, status: 'published' }).sort({ createdAt: -1 }).limit(30).lean();
	// Growth-minded ranking: everyone's feed reserves real room for new voices
	// alongside the reach of larger communities, so posts from small/new
	// accounts and communities are not permanently buried under popularity.
	const slots = [
		...ownPosts.map((post) => ({ ...post, feedSource: post.status === 'draft' ? 'Draft' : post.status === 'scheduled' ? 'Scheduled' : post.status === 'pending' ? 'Awaiting community review' : 'Your post' })),
		...followedPosts.slice(0, 6).map((post) => ({ ...post, feedSource: 'From people you follow' })),
		...extendedPosts.slice(0, 4).map((post) => ({ ...post, feedSource: 'Connected to your network' })),
		...newPosts.slice(0, 6).map((post) => ({ ...post, feedSource: 'New voices & communities' })),
		...largePosts.slice(0, 8).map((post) => ({ ...post, feedSource: 'Large communities' })),
		...viralPosts.slice(0, 6).map((post) => ({ ...post, feedSource: 'Viral right now' }))
	];
	const used = new Set();
	const uniqueSlots = slots.filter((post) => {
		const id = String(post._id);
		if (used.has(id)) return false;
		used.add(id);
		return true;
	});
	recentPosts.forEach((post) => {
		if (uniqueSlots.length < 26 && !used.has(String(post._id))) {
			used.add(String(post._id));
			uniqueSlots.push({ ...post, feedSource: 'Fresh from Crowdwide' });
		}
	});
	uniqueSlots.sort((left, right) => (right.moderationScore || 0) - (left.moderationScore || 0));
	return { posts: await populatePosts(uniqueSlots), label: 'Normal feed', note: 'A mix of people you follow, your extended network, new voices, and larger communities - so growing accounts still get seen.' };
}

exports.dashboard = async (req, res) => {
	try {
		const user = await User.findById(req.session.user.id).lean();
		const mode = req.query.feed === 'personalized' ? 'personalized' : 'normal';
		const followingIds = (user.following || []).map(String);
		const blockedIds = (user.blockedUsers || []).map(String);
		const [feed, communities, people, viralPosts] = await Promise.all([
			buildFeed(user, mode),
			Community.find().sort({ membersCount: -1, createdAt: -1 }).limit(6).lean(),
			User.find({ _id: { $ne: user._id, $nin: [...(user.following || []), ...(user.blockedUsers || [])] }, isVerified: true }).sort({ createdAt: -1 }).limit(5).select('name profilePicture').lean(),
			getViralPosts(20)
		]);
		const bookmarked = (user.bookmarks || []).map(String);
		feed.posts = feed.posts
			.filter((post) => !blockedIds.includes(String(post.author?._id)))
			.map((post) => ({ ...post, liked: (post.likes || []).some((id) => String(id) === String(user._id)), bookmarked: bookmarked.includes(String(post._id)) }));
		const viralIds = new Set(viralPosts.map((post) => String(post._id)));
		const [latestPosts, latestArticles] = await Promise.all(['post', 'article'].map(async (type) => {
			const posts = await Post.find({ status: 'published', type }).sort({ createdAt: -1 }).limit(30).lean();
			return populatePosts(posts);
		}));
		const decorateTabPosts = (posts) => posts
			.filter((post) => !blockedIds.includes(String(post.author?._id)))
			.map((post) => ({ ...post, liked: (post.likes || []).some((id) => String(id) === String(user._id)), bookmarked: bookmarked.includes(String(post._id)) }));
		const decoratedLatestPosts = decorateTabPosts(latestPosts);
		const decoratedLatestArticles = decorateTabPosts(latestArticles);
		const viralPostItems = feed.posts.filter((post) => viralIds.has(String(post._id)));
		const viralArticleItems = viralPostItems.filter((post) => post.type === 'article');
		const groups = { 'for-you': feed.posts, 'my-community': feed.posts, 'posts-new': decoratedLatestPosts, 'posts-viral': viralPostItems.filter((post) => post.type !== 'article'), 'articles-new': decoratedLatestArticles, 'articles-viral': viralArticleItems };
		const activeTab = ['for-you', 'my-community', 'posts-new', 'posts-viral', 'articles-new', 'articles-viral'].includes(req.query.view) ? req.query.view : (mode === 'personalized' ? 'my-community' : 'for-you');
		res.render('pages/dashboard', { title: 'Your Crowdwide', pagePath: '/dashboard', noIndex: true, feed: { ...feed, latestPosts: decoratedLatestPosts, latestArticles: decoratedLatestArticles, viralPosts: viralPostItems, viralArticles: viralArticleItems, activeTab, visiblePosts: groups[activeTab] }, communities, people, joinedCommunities: (user.joinedCommunities || []).map(String), following: followingIds });
	} catch (error) {
		console.error('Unable to load dashboard:', error.message);
		res.status(500).render('pages/not-found', { title: 'Dashboard unavailable', noIndex: true });
	}
};

exports.createPost = async (req, res) => {
	const body = req.body.body?.trim();
	const type = ['article', 'poll'].includes(req.body.type) ? req.body.type : 'post';
	const wordLimit = type === 'article' ? 550 : 120;
	const wordCount = body ? body.split(/\s+/).filter(Boolean).length : 0;
	if (!body || wordCount > wordLimit) {
		req.session.flash = { type: 'error', message: `${type === 'article' ? 'Articles' : 'Posts'} are limited to ${wordLimit} words.` };
		return res.redirect('/dashboard');
	}
	const pollQuestion = req.body.pollQuestion?.trim();
	const pollOptions = (Array.isArray(req.body.pollOptions) ? req.body.pollOptions : [req.body.pollOptions])
		.map((option) => option?.trim()).filter(Boolean).filter((option, index, options) => options.indexOf(option) === index).slice(0, 4);
	if (type === 'poll' && (!pollQuestion || pollOptions.length < 2)) {
		req.session.flash = { type: 'error', message: 'Polls are available on posts and need at least two options.' };
		return res.redirect('/dashboard');
	}
	let status = 'published';
	let scheduledAt;
	if (req.body.community) {
		const community = await Community.findById(req.body.community).select('members bannedWords owner moderators requireApproval');
		if (!community || !community.members.some((id) => String(id) === String(req.session.user.id))) {
			req.session.flash = { type: 'error', message: 'Join that community before posting there.' };
			return res.redirect('/dashboard');
		}
		const bodyLower = body.toLowerCase();
		if ((community.bannedWords || []).some((word) => word && bodyLower.includes(word))) {
			req.session.flash = { type: 'error', message: 'That post contains a word this community has blocked.' };
			return res.redirect('/dashboard');
		}
		const isStaff = String(community.owner) === String(req.session.user.id) || community.moderators.some((id) => String(id) === String(req.session.user.id));
		if (community.requireApproval && !isStaff) status = 'pending';
	}
	if (req.body.scheduledAt && req.body.saveAsDraft !== 'on') {
		scheduledAt = new Date(req.body.scheduledAt);
		if (Number.isNaN(scheduledAt.getTime()) || scheduledAt <= new Date()) {
			req.session.flash = { type: 'error', message: 'Choose a future time to schedule this post.' };
			return res.redirect('/dashboard');
		}
		if (status === 'pending') {
			req.session.flash = { type: 'error', message: 'Scheduled posts cannot wait for community approval. Publish it after approval instead.' };
			return res.redirect('/dashboard');
		}
		status = 'scheduled';
	}
	const media = [];
	for (const file of req.files || []) {
		const stored = await uploadBuffer(file.buffer, file.originalname, file.mimetype, { kind: file.mediaKind, owner: req.session.user.id });
		const item = { url: mediaUrl(stored), storageKey: stored.id, kind: file.mediaKind, alt: req.body.mediaAlt?.trim() || '' };
		if (file.mediaKind === 'image') {
			const thumbnail = await createImageThumbnail(file.buffer);
			const thumbnailFile = await uploadBuffer(thumbnail, `${file.originalname}.thumb.webp`, 'image/webp', { kind: 'thumbnail', parent: stored.id, owner: req.session.user.id });
			item.thumbnailUrl = mediaUrl(thumbnailFile);
		}
		media.push(item);
	}
	const isDraft = req.body.saveAsDraft === 'on';
	const createdPost = await Post.create({ author: req.session.user.id, body, type, community: req.body.community || undefined, media, hashtags: extractHashtags(body), poll: type === 'poll' ? { question: pollQuestion, options: pollOptions.map((label) => ({ label, votes: [] })) } : undefined, status: isDraft ? 'draft' : status, scheduledAt: isDraft ? undefined : scheduledAt });
	if (!isDraft) await notifyMentionedUsers(body, req.session.user.id, createdPost._id, createdPost.community);
	if (isDraft) {
		req.session.flash = { type: 'success', message: 'Draft saved. It is visible only to you.' };
	} else if (status === 'scheduled') {
		req.session.flash = { type: 'success', message: `Scheduled for ${scheduledAt.toLocaleString()}.` };
	} else if (status === 'pending') {
		req.session.flash = { type: 'success', message: 'Posted - this community reviews posts before they appear, so a moderator needs to approve it first.' };
	}
	res.redirect('/dashboard');
};

exports.signedUpload = async (req, res) => {
	const allowed = ['image/', 'video/', 'audio/'];
	const kind = req.query.kind;
	const contentType = req.query.contentType || '';
	if (!allowed.some((prefix) => contentType.startsWith(prefix)) || !['image', 'video', 'audio'].includes(kind)) return res.status(400).json({ error: 'Unsupported media type.' });
	const result = await createSignedUpload({ userId: req.session.user.id, kind, contentType });
	if (!result.configured) return res.status(503).json({ error: 'Google Cloud Storage is not configured.' });
	res.json(result);
};

exports.health = (req, res) => {
	const databaseReady = User.db.readyState === 1;
	res.status(databaseReady ? 200 : 503).json({
		status: databaseReady ? 'ok' : 'degraded',
		service: 'crowdwide',
		database: databaseReady ? 'ready' : 'unavailable',
		timestamp: new Date().toISOString()
	});
};

exports.media = (req, res) => streamFile(Number(req.params.cluster), req.params.id, res);

exports.mediaStatus = async (req, res) => res.json({ clusters: await clusterStatus() });

exports.createCommunity = async (req, res) => {
	const name = req.body.name?.trim();
	if (name) {
		const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
		await Community.create({ owner: req.session.user.id, name, slug, category: req.body.category?.trim().toLowerCase() || 'general', isPrivate: req.body.isPrivate === 'on', hashtags: parseHashtagList(req.body.hashtags), description: req.body.description?.trim() || `A new Crowdwide community for ${name}.`, members: [req.session.user.id], memberRoles: [{ user: req.session.user.id, role: 'member' }], membersCount: 1 });
	}
	res.redirect('/dashboard');
};

exports.profile = async (req, res) => {
	const profileUser = await User.findById(req.params.id).select('name email bio hashtags links profilePicture bannerImage privacy createdAt isVerified following').lean();
	if (!profileUser) return res.status(404).render('pages/not-found', { title: 'Profile not found' });
	const viewerId = req.session.user.id;
	const isSelf = String(profileUser._id) === String(viewerId);
	let tab = ['posts', 'activity', 'likes', 'comments', 'saved'].includes(req.query.tab) ? req.query.tab : 'posts';
	if (!isSelf && tab === 'saved') tab = 'posts';
	const postFilter = isSelf ? { author: profileUser._id } : { author: profileUser._id, status: 'published' };
	const [posts, followersCount, viewer, postCount, likedPosts, comments] = await Promise.all([
		Post.find(postFilter).sort({ createdAt: -1 }).limit(30).populate('community', 'name slug').lean(),
		User.countDocuments({ following: profileUser._id }),
		User.findById(viewerId).select('following bookmarks blockedUsers').lean(),
		Post.countDocuments({ author: profileUser._id, status: 'published' }),
		Post.find({ likes: profileUser._id, status: 'published' }).sort({ updatedAt: -1 }).limit(30).populate('community', 'name slug').lean(),
		Comment.find({ author: profileUser._id }).sort({ createdAt: -1 }).limit(30).populate({ path: 'post', select: 'body author createdAt', populate: { path: 'author', select: 'name' } }).lean()
	]);
	const populatedPosts = (await Post.populate(posts, { path: 'author', select: 'name profilePicture' }));
	const populatedLikes = (await Post.populate(likedPosts, { path: 'author', select: 'name profilePicture' }));
	const bookmarked = (viewer?.bookmarks || []).map(String);
	const posts_ = populatedPosts.map((post) => ({ ...post, liked: (post.likes || []).some((id) => String(id) === String(viewerId)), bookmarked: bookmarked.includes(String(post._id)) }));
	let savedPosts = [];
	if (isSelf && bookmarked.length) {
		savedPosts = await Post.find({ _id: { $in: bookmarked }, status: 'published' }).sort({ createdAt: -1 }).populate('community', 'name slug').lean();
		savedPosts = await Post.populate(savedPosts, { path: 'author', select: 'name profilePicture' });
	}

	let activity = [];
	let suggestions = [];
	if (isSelf) {
		const [myComments, followingIds] = await Promise.all([
			Comment.find({ author: profileUser._id }).sort({ createdAt: -1 }).limit(6).populate('post', 'body author').lean(),
			Promise.resolve((viewer?.following || []).map(String))
		]);
		activity = [
			...populatedLikes.slice(0, 6).map((post) => ({ kind: 'like', post, at: post.updatedAt })),
			...myComments.filter((comment) => comment.post).map((comment) => ({ kind: 'comment', comment, at: comment.createdAt }))
		].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 6);
		suggestions = await getPopularPeople(5, [...followingIds, profileUser._id]);
	}

	res.render('pages/profile', {
		title: `${profileUser.name} on Crowdwide`,
		pagePath: `/u/${profileUser._id}`,
		noIndex: profileUser.privacy !== 'public',
		profileUser,
		posts: posts_,
		profileTab: tab,
		profileLikes: populatedLikes,
		profileComments: comments,
		savedPosts,
		postCount,
		followersCount,
		followingCount: (profileUser.following || []).length,
		isSelf,
		isFollowing: !isSelf && (viewer?.following || []).some((id) => String(id) === String(profileUser._id)),
		isFollowingBack: !isSelf && (profileUser.following || []).some((id) => String(id) === String(viewerId)),
		isBlocked: !isSelf && (viewer?.blockedUsers || []).some((id) => String(id) === String(profileUser._id)),
		activity,
		suggestions
	});
};

exports.search = async (req, res) => {
	const q = (req.query.q || '').trim();
	const trendingHashtags = await getTrendingHashtags(12);
	if (!q) return res.render('pages/search', { title: 'Search Crowdwide', pagePath: '/search', noIndex: true, query: '', users: [], communities: [], posts: [], hashtag: null, trendingHashtags, popularSearches: trendingHashtags });
	const tag = q.startsWith('#') ? q.slice(1).toLowerCase().replace(/[^a-z0-9_]/g, '') : null;
	const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const regex = new RegExp(safe, 'i');
	const viewer = await User.findById(req.session.user.id).select('blockedUsers').lean();
	const [users, communities, posts] = await Promise.all([
		User.find({ isVerified: true, _id: { $nin: viewer?.blockedUsers || [] }, ...(tag ? { hashtags: tag } : { $or: [{ name: regex }, { bio: regex }, { hashtags: q.toLowerCase() }] }) }).limit(10).select('name bio hashtags profilePicture').lean(),
		Community.find(tag ? { hashtags: tag } : { $or: [{ name: regex }, { description: regex }, { hashtags: q.toLowerCase() }] }).limit(10).lean(),
		Post.find({ status: 'published', author: { $nin: viewer?.blockedUsers || [] }, ...(tag ? { hashtags: tag } : { body: regex }) }).sort({ createdAt: -1 }).limit(20).populate('author', 'name profilePicture').populate('community', 'name slug').lean()
	]);
	res.render('pages/search', { title: `“${q}” on Crowdwide`, pagePath: '/search', noIndex: true, query: q, users, communities, posts, hashtag: tag, trendingHashtags, popularSearches: trendingHashtags });
};

exports.hashtagSuggestions = async (req, res) => {
	const prefix = (req.query.q || '').replace(/^#/, '').toLowerCase().replace(/[^a-z0-9_]/g, '');
	const hashtags = await getTrendingHashtags(30);
	res.json(hashtags.filter(({ tag }) => !prefix || tag.startsWith(prefix)).slice(0, 8));
};

exports.userSuggestions = async (req, res) => {
	const prefix = (req.query.q || '').replace(/^@/, '').toLowerCase().replace(/[^a-z0-9._-]/g, '');
	if (!prefix) return res.json([]);
	const safe = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const regex = new RegExp(`^${safe}`, 'i');
	const viewer = await User.findById(req.session.user.id).select('blockedUsers').lean();
	const users = await User.find({ isVerified: true, _id: { $ne: req.session.user.id, $nin: viewer?.blockedUsers || [] }, $or: [{ name: regex }, { email: regex }] }).limit(8).select('name email profilePicture').lean();
	res.json(users.map((user) => ({ id: user._id, name: user.name, handle: user.email.split('@')[0], profilePicture: user.profilePicture })));
};

exports.followersPage = async (req, res) => {
	const profileUser = await User.findById(req.params.id).select('name profilePicture').lean();
	if (!profileUser) return res.status(404).render('pages/not-found', { title: 'Profile not found' });
	const viewer = await User.findById(req.session.user.id).select('following').lean();
	const followingSet = new Set((viewer.following || []).map(String));
	const [followers, suggestions] = await Promise.all([
		User.find({ following: profileUser._id }).select('name bio profilePicture').limit(60).lean(),
		getPopularPeople(6, [profileUser._id, req.session.user.id])
	]);
	res.render('pages/connections', { title: `People following ${profileUser.name}`, pagePath: `/u/${profileUser._id}/followers`, noIndex: true, profileUser, mode: 'followers', list: followers, followingSet: Array.from(followingSet), suggestions });
};

exports.followingPage = async (req, res) => {
	const profileUser = await User.findById(req.params.id).select('name profilePicture following').lean();
	if (!profileUser) return res.status(404).render('pages/not-found', { title: 'Profile not found' });
	const viewer = await User.findById(req.session.user.id).select('following').lean();
	const followingSet = new Set((viewer.following || []).map(String));
	const [following, suggestions] = await Promise.all([
		User.find({ _id: { $in: profileUser.following || [] } }).select('name bio profilePicture').limit(60).lean(),
		getPopularPeople(6, [...(profileUser.following || []), req.session.user.id])
	]);
	res.render('pages/connections', { title: `People ${profileUser.name} follows`, pagePath: `/u/${profileUser._id}/following`, noIndex: true, profileUser, mode: 'following', list: following, followingSet: Array.from(followingSet), suggestions });
};

exports.guide = (req, res) => {
	const topics = [
		{
			heading: 'Creating your account',
			tips: [
				'Use a real name or a consistent handle - people are more likely to follow and reply to an identity they recognize.',
				'Verify your email right away; posting, following, and joining communities all require a verified account.',
				'Turn on two-factor authentication from Settings → Security, and download your recovery codes somewhere safe in case you lose your authenticator app.'
			]
		},
		{
			heading: 'Growing your profile',
			tips: [
				'Write a short bio that says what you post about - specific beats vague ("I write about longboard repair" beats "into stuff").',
				'Add up to four links to your profile (portfolio, other socials, a project) so people can go deeper after a good post.',
				'Upload a profile picture and a banner image - profiles with a real photo get more follows than blank initials.',
				'Post consistently rather than in bursts. The feed favors accounts that show up regularly, especially newer ones.'
			]
		},
		{
			heading: 'Writing posts that get seen',
			tips: [
				'Lead with the interesting part in your first sentence - it is what shows in feed previews.',
				'Add 2-4 relevant hashtags (like #woodworking or #mongodb) so your post surfaces in hashtag search and community discovery, not just your followers\' feeds.',
				'Attach one clear image, short video, or audio clip when it adds real context - posts with media get more attention while still loading fast.',
				'Post inside a relevant community when one fits. Community posts reach people who already care about the topic, not just your existing followers.'
			]
		},
		{
			heading: 'Growing a community',
			tips: [
				'Pick a specific name, description, and category - specific communities are easier to discover and easier to explain to new members.',
				'Add hashtags to your community so it turns up in hashtag search and the Explore page.',
				'Upload a banner and profile picture for your community - a visual identity makes it feel worth joining.',
				'Write clear community guidelines. New members are more likely to participate well when expectations are explicit.',
				'Add trusted members as moderators (by their username or email) once the community grows past what you can review alone.',
				'Turn on "review posts before they appear" if you want to keep quality high while the community is small - you can turn it off later.'
			]
		},
		{
			heading: 'Following, blocking, and your feed',
			tips: [
				'Your home feed mixes posts from people you follow, posts from people connected to your network, new voices from small communities, and a little of what is currently popular - so following a handful of people already shapes it.',
				'Use Follow on any profile to add their posts to your feed; use Block if someone is bothering you - blocking also removes any follow relationship between you.',
				'Check your Followers and Following lists from your profile - both pages suggest new people worth connecting with.'
			]
		},
		{
			heading: 'Staying secure',
			tips: [
				'Use a unique password for Crowdwide, and change it from Settings → Security if you ever suspect it was exposed elsewhere.',
				'Review your signed-in devices in Settings → Security and log out anything you do not recognize.',
				'Keep your two-factor recovery codes somewhere safe (a password manager is ideal) - each code only works once.'
			]
		}
	];
	res.render('pages/guide', { title: 'Guide & tips', pagePath: '/guide', description: 'Practical tips for getting the most out of Crowdwide - growing a profile, growing a community, and staying secure.', topics });
};

exports.moreFeedPosts = async (req, res) => {
	const user = await User.findById(req.session.user.id).select('joinedCommunities bookmarks blockedUsers').lean();
	const before = new Date(req.query.before);
	const cursor = Number.isNaN(before.getTime()) ? new Date() : before;
	const mode = req.query.feed === 'personalized' ? 'personalized' : 'normal';
	const blockedIds = (user.blockedUsers || []).map(String);
	// Infinite scroll continues as a straight recency stream (not the
	// weighted mix used for the first page) - simple, predictable, and cheap
	// to paginate deep into the feed.
	const filter = { status: 'published', createdAt: { $lt: cursor } };
	if (req.query.view === 'posts-new') filter.type = 'post';
	if (req.query.view === 'articles-new') filter.type = 'article';
	if (mode === 'personalized') filter.community = { $in: user.joinedCommunities || [] };
	const posts = await Post.find(filter).sort({ createdAt: -1 }).limit(10).lean();
	const populated = (await populatePosts(posts)).filter((post) => !blockedIds.includes(String(post.author?._id)));
	const bookmarked = (user.bookmarks || []).map(String);
	const ready = populated.map((post) => ({ ...post, feedSource: 'Further back', liked: (post.likes || []).some((id) => String(id) === String(user._id)), bookmarked: bookmarked.includes(String(post._id)) }));
	res.render('partials/post-cards-fragment', { posts: ready, csrfToken: res.locals.csrfToken }, (err, html) => {
		if (err) return res.status(500).json({ error: 'Could not load more posts.' });
		res.json({ html, done: posts.length < 10, cursor: posts.length ? posts[posts.length - 1].createdAt : null });
	});
};

exports.infoPage = (req, res) => {
	const pages = {
		'/about': {
			title: 'About Crowdwide',
			heading: 'The internet can feel human again.',
			intro: 'Crowdwide is a social discovery platform for people who want more signal, more context, and more room for new voices - built around communities and curiosity instead of follower counts.',
			sections: [
				['Our idea', 'The best communities are not built around reach. They are built around recognition: the feeling that someone else is paying attention to the same fascinating thing you are. Crowdwide organizes around communities and hashtags first, so a good post from a brand-new account has the same chance of being found as one from an account with a huge following.'],
				['How the feed works', 'Your home feed blends posts from people you follow, fresh posts from small and new communities, and a small slice of what is currently resonating widely. New accounts and new communities are deliberately given feed space, not buried under popularity, because a network only stays interesting if new voices can still break through.'],
				['Communities, not just followers', 'Communities on Crowdwide can be public or private, can carry their own hashtags and banner/avatar images, and can set their own guidelines. Owners can add moderators, and communities may optionally require posts to be reviewed before they appear.'],
				['Our promise', 'We are building tools that reward curiosity, thoughtful participation, and the quality of a connection over the size of a following. If a feature does not help people find each other or make something worth returning to, it does not belong here.']
			]
		},
		'/about/developer': {
			title: 'About the developer',
			heading: 'Built with care, in public.',
			intro: 'Crowdwide is an independent project focused on making online discovery feel generous and useful again.',
			sections: [
				['A small team mindset', 'Every feature starts with a simple question: does this help people find each other and make something worth returning to?'],
				['What is being built next', 'Active areas of work include richer community moderation tools, hashtag discovery, and a feed that better balances people you follow with people you have not met yet.'],
				['Get in touch', 'For product feedback, bug reports, accessibility concerns, or partnership ideas, reach out at <a href="mailto:developerpuneet2010@gmail.com">developerpuneet2010@gmail.com</a>.']
			]
		},
		'/privacy': {
			title: 'Privacy policy',
			heading: 'Your data deserves context.',
			updated: 'Last updated September 2026',
			intro: 'This policy explains what Crowdwide collects, why it is needed, and the choices available to you. Crowdwide is built to work across your devices, which means some information has to be stored so the service can function.',
			sections: [
				['What we collect', 'Account details you provide (name, email, password hash, bio, links), content you create (posts, comments, communities, hashtags), media you upload (images, video, audio, avatars, banners), and limited technical information such as IP address, device/browser identifiers, and session activity used to keep accounts secure.'],
				['How we use it', 'We use this information to authenticate accounts, deliver verification and security emails, operate core features like feeds, search, and notifications, prevent abuse and spam, and improve the product over time.'],
				['Where it is stored', 'Account data, posts, and community data are stored in MongoDB. Media (images, video, audio, avatars, and community banners) is stored in MongoDB GridFS, optionally distributed across multiple MongoDB clusters for capacity, or in a configured Google Cloud Storage bucket. We do not sell your data to third parties or use it to serve third-party ads.'],
				['Cookies and sessions', 'Crowdwide uses a single session cookie to keep you signed in. It is required for the app to function and is not used for cross-site advertising tracking.'],
				['Your choices', 'You can edit or remove your profile details, links, and media at any time from Settings. You can download a copy of your data from Settings → Account, and you can permanently delete your account and its content from the same page. For anything else, contact us at <a href="mailto:developerpuneet2010@gmail.com">developerpuneet2010@gmail.com</a>.'],
				['Children', 'Crowdwide is not directed at children under 13, and we do not knowingly collect information from children under 13.']
			]
		},
		'/terms': {
			title: 'Terms of use',
			heading: 'A few promises in both directions.',
			updated: 'Last updated September 2026',
			intro: 'These terms describe the expectations for using Crowdwide and the responsibilities we share as a community. By creating an account, you agree to these terms.',
			sections: [
				['Your account', 'You are responsible for the activity on your account and for keeping your password (and two-factor recovery codes, if enabled) secure. You must be old enough to use online services in your country to create an account.'],
				['Use with care', 'Do not use Crowdwide to harass, deceive, impersonate, exploit, or harm people. Do not upload content you do not have the right to share, and do not attempt to circumvent moderation, rate limits, or security controls.'],
				['Your content', 'You retain ownership of the content you post. You give Crowdwide permission to store, display, and process it only as needed to operate the service (for example, generating thumbnails or serving it through the feed).'],
				['Communities', 'Community owners and moderators are responsible for keeping their communities within these terms and Crowdwide\'s Community Guidelines, including reviewing reported content and managing membership.'],
				['Termination', 'We may suspend or remove accounts or content that clearly violate these terms or the Community Guidelines. You may delete your account at any time from Settings.'],
				['The service', 'Crowdwide is evolving. Features may change, and we will make a reasonable effort to communicate material changes. The service is provided "as is" without warranties of any kind.']
			]
		},
		'/community-guidelines': {
			title: 'Community guidelines',
			heading: 'Make room for people.',
			intro: 'Crowdwide works when people can participate without being diminished, manipulated, or pushed out. These guidelines apply across every community.',
			sections: [
				['Bring curiosity', 'Ask honest questions, share context, and disagree with ideas without attacking the people behind them.'],
				['Protect boundaries', 'Respect privacy, consent, and the right of others to leave a conversation or block someone who is bothering them.'],
				['No harassment or hate', 'Targeted harassment, hate speech, threats, and doxxing are never allowed and will result in account removal.'],
				['Community-specific rules', 'Individual communities may set their own guidelines, banned words, and review-before-posting policies. Owners and moderators can remove members and posts that break those rules.'],
				['Report problems', 'If something feels unsafe or clearly violates these guidelines, use the block feature and report it to <a href="mailto:developerpuneet2010@gmail.com">developerpuneet2010@gmail.com</a> so it can be reviewed.']
			]
		},
		'/accessibility': {
			title: 'Accessibility',
			heading: 'Designed for more ways of being here.',
			intro: 'We want Crowdwide to be usable by as many people as possible across devices, abilities, and connection speeds.',
			sections: [
				['Our approach', 'We use semantic HTML, keyboard-friendly controls, readable contrast, responsive layouts down to small phone screens, and meaningful labels as a baseline.'],
				['Media', 'Images support alt text, and video/audio use standard browser controls that work with assistive technology.'],
				['Tell us what is missing', 'Accessibility is ongoing work. Please report a barrier with the page URL and a description of what happened to <a href="mailto:developerpuneet2010@gmail.com">developerpuneet2010@gmail.com</a> so we can investigate.']
			]
		},
		'/contact': {
			title: 'Contact Crowdwide',
			heading: 'Bring us a thought.',
			intro: 'Questions, feedback, bug reports, and thoughtful criticism are welcome.',
			contactEmail: 'developerpuneet2010@gmail.com',
			sections: [
				['Product feedback', 'Tell us what you were trying to do, what happened, and what would have made the experience better.'],
				['Bug reports', 'Include the page you were on, what you expected, and what happened instead. Screenshots help a lot.'],
				['Safety and privacy', 'For account, privacy, or safety concerns, include enough detail for us to locate the issue without sending passwords or private credentials.'],
				['Response time', 'This is an independently run project, so replies are not instant - but every message is read.']
			]
		}
	};
	const page = pages[req.path] || pages['/about'];
	res.render('pages/info', { ...page, pagePath: req.path, description: page.intro });
};

exports.robots = (req, res) => { res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /dashboard\nDisallow: /auth/\nSitemap: ${(process.env.APP_URL || 'http://localhost:3000')}/sitemap.xml`); };
exports.sitemap = (req, res) => { res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/about', '/about/developer', '/privacy', '/terms', '/community-guidelines', '/accessibility', '/contact', '/auth/login', '/auth/register'].map((path) => `<url><loc>${(process.env.APP_URL || 'http://localhost:3000')}${path}</loc></url>`).join('')}</urlset>`); };
