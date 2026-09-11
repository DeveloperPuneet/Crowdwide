const User = require('../models/User');
const Post = require('../models/Post');
const Community = require('../models/Community');
const { createSignedUpload, createImageThumbnail } = require('../services/storage');
const { uploadBuffer, streamFile, mediaUrl, clusterStatus } = require('../services/storageCluster');
const Comment = require('../models/Comment');

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
		res.render('pages/home', {
			title: 'A fair chance at discovery',
			description: 'Crowdwide gives every voice a fair chance at discovery through thoughtful communities and real conversation.',
			pagePath: '/',
			stats,
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
		res.render('pages/home', { title: 'A fair chance at discovery', pagePath: '/', stats: { members: 0, posts: 0, communities: 0, communitiesAreLive: false, topCommunities: [] } });
	}
};

async function populatePosts(posts) {
	const populated = await Post.populate(posts, [
		{ path: 'author', select: 'name createdAt profilePicture' },
		{ path: 'community', select: 'name slug membersCount' }
	]);
	const comments = await Comment.find({ post: { $in: posts.map((post) => post._id) } }).sort({ createdAt: 1 }).limit(200).populate('author', 'name').lean();
	return populated.map((post) => ({ ...post, comments: comments.filter((comment) => String(comment.post) === String(post._id)) }));
}

async function buildFeed(user, mode) {
	const joinedIds = user.joinedCommunities || [];
	const followingIds = user.following || [];
	if (mode === 'personalized') {
		const personalizedFilter = joinedIds.length ? { community: { $in: joinedIds } } : { _id: { $in: [] } };
		return { posts: await populatePosts(await Post.find(personalizedFilter).sort({ createdAt: -1 }).limit(30).lean()), label: 'Personalized feed', note: joinedIds.length ? 'Posts and articles from communities you joined.' : 'Join a community to shape this feed.' };
	}

	const recentCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
	const [followedPosts, newPosts, largeCommunities, viralPosts, recentPosts] = await Promise.all([
		followingIds.length ? Post.find({ author: { $in: followingIds } }).sort({ createdAt: -1 }).limit(10).lean() : Promise.resolve([]),
		Post.find({ $or: [{ createdAt: { $gte: recentCutoff } }, { community: { $exists: false } }] }).sort({ createdAt: -1 }).limit(20).lean(),
		Community.find().sort({ membersCount: -1 }).limit(20).select('_id').lean(),
		Post.aggregate([{ $addFields: { likesTotal: { $size: { $ifNull: ['$likes', []] } } } }, { $sort: { likesTotal: -1, createdAt: -1 } }, { $limit: 20 }]),
		Post.find().sort({ createdAt: -1 }).limit(30).lean()
	]);
	const largeIds = largeCommunities.map((community) => community._id);
	const largePosts = await Post.find({ community: { $in: largeIds } }).sort({ createdAt: -1 }).limit(30).lean();
	// Growth-minded ranking: everyone's feed reserves real room for new voices
	// alongside the reach of larger communities, so posts from small/new
	// accounts and communities are not permanently buried under popularity.
	const slots = [
		...followedPosts.slice(0, 6).map((post) => ({ ...post, feedSource: 'From people you follow' })),
		...newPosts.slice(0, 7).map((post) => ({ ...post, feedSource: 'New voices & communities' })),
		...largePosts.slice(0, 10).map((post) => ({ ...post, feedSource: 'Large communities' })),
		...viralPosts.slice(0, 1).map((post) => ({ ...post, feedSource: 'Viral right now' }))
	];
	const used = new Set(slots.map((post) => String(post._id)));
	recentPosts.forEach((post) => { if (slots.length < 24 && !used.has(String(post._id))) slots.push({ ...post, feedSource: 'Fresh from Crowdwide' }); });
	return { posts: await populatePosts(slots), label: 'Normal feed', note: 'A mix of people you follow, new voices, and larger communities - so growing accounts still get seen.' };
}

exports.dashboard = async (req, res) => {
	try {
		const user = await User.findById(req.session.user.id).lean();
		const mode = req.query.feed === 'personalized' ? 'personalized' : 'normal';
		const followingIds = (user.following || []).map(String);
		const [feed, communities, people] = await Promise.all([
			buildFeed(user, mode),
			Community.find().sort({ membersCount: -1, createdAt: -1 }).limit(6).lean(),
			User.find({ _id: { $ne: user._id, $nin: user.following || [] }, isVerified: true }).sort({ createdAt: -1 }).limit(5).select('name profilePicture').lean()
		]);
		const bookmarked = (user.bookmarks || []).map(String);
		feed.posts = feed.posts.map((post) => ({ ...post, liked: (post.likes || []).some((id) => String(id) === String(user._id)), bookmarked: bookmarked.includes(String(post._id)) }));
		res.render('pages/dashboard', { title: 'Your Crowdwide', pagePath: '/dashboard', noIndex: true, feed, communities, people, joinedCommunities: (user.joinedCommunities || []).map(String), following: followingIds });
	} catch (error) {
		console.error('Unable to load dashboard:', error.message);
		res.status(500).render('pages/not-found', { title: 'Dashboard unavailable', noIndex: true });
	}
};

exports.createPost = async (req, res) => {
	const body = req.body.body?.trim();
	const type = req.body.type === 'article' ? 'article' : 'post';
	const limit = type === 'article' ? 50000 : 5000;
	if (!body || body.length > limit) {
		req.session.flash = { type: 'error', message: `${type === 'article' ? 'Articles' : 'Posts'} are limited to ${limit.toLocaleString()} characters.` };
		return res.redirect('/dashboard');
	}
	if (req.body.community) {
		const community = await Community.findById(req.body.community).select('members bannedWords');
		if (!community || !community.members.some((id) => String(id) === String(req.session.user.id))) {
			req.session.flash = { type: 'error', message: 'Join that community before posting there.' };
			return res.redirect('/dashboard');
		}
		const bodyLower = body.toLowerCase();
		if ((community.bannedWords || []).some((word) => word && bodyLower.includes(word))) {
			req.session.flash = { type: 'error', message: 'That post contains a word this community has blocked.' };
			return res.redirect('/dashboard');
		}
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
	await Post.create({ author: req.session.user.id, body, type, community: req.body.community || undefined, media });
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

exports.health = (req, res) => res.json({ status: 'ok', service: 'crowdwide', timestamp: new Date().toISOString() });

exports.media = (req, res) => streamFile(Number(req.params.cluster), req.params.id, res);

exports.mediaStatus = async (req, res) => res.json({ clusters: await clusterStatus() });

exports.createCommunity = async (req, res) => {
	const name = req.body.name?.trim();
	if (name) {
		const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
		await Community.create({ owner: req.session.user.id, name, slug, category: req.body.category?.trim().toLowerCase() || 'general', isPrivate: req.body.isPrivate === 'on', description: req.body.description?.trim() || `A new Crowdwide community for ${name}.`, members: [req.session.user.id], memberRoles: [{ user: req.session.user.id, role: 'member' }], membersCount: 1 });
	}
	res.redirect('/dashboard');
};

exports.joinCommunity = async (req, res) => {
	const community = await Community.findById(req.params.id);
	const user = await User.findById(req.session.user.id);
	const joinedCommunities = user?.joinedCommunities || [];
	if (community && user && !joinedCommunities.some((id) => String(id) === String(community._id))) {
		user.joinedCommunities.push(community._id);
		community.members.push(user._id);
		community.membersCount = community.members.length;
		await Promise.all([user.save(), community.save()]);
	}
	res.redirect('/dashboard');
};

exports.profile = async (req, res) => {
	const profileUser = await User.findById(req.params.id).select('name email bio profilePicture privacy createdAt isVerified following').lean();
	if (!profileUser) return res.status(404).render('pages/not-found', { title: 'Profile not found' });
	const viewerId = req.session.user.id;
	const isSelf = String(profileUser._id) === String(viewerId);
	const [posts, followersCount, viewer, postCount] = await Promise.all([
		Post.find({ author: profileUser._id }).sort({ createdAt: -1 }).limit(30).populate('community', 'name slug').lean(),
		User.countDocuments({ following: profileUser._id }),
		User.findById(viewerId).select('following bookmarks').lean(),
		Post.countDocuments({ author: profileUser._id })
	]);
	const populatedPosts = (await Post.populate(posts, { path: 'author', select: 'name profilePicture' }));
	const bookmarked = (viewer?.bookmarks || []).map(String);
	const posts_ = populatedPosts.map((post) => ({ ...post, liked: (post.likes || []).some((id) => String(id) === String(viewerId)), bookmarked: bookmarked.includes(String(post._id)) }));
	res.render('pages/profile', {
		title: `${profileUser.name} on Crowdwide`,
		pagePath: `/u/${profileUser._id}`,
		noIndex: profileUser.privacy !== 'public',
		profileUser,
		posts: posts_,
		postCount,
		followersCount,
		followingCount: (profileUser.following || []).length,
		isSelf,
		isFollowing: !isSelf && (viewer?.following || []).some((id) => String(id) === String(profileUser._id))
	});
};

exports.search = async (req, res) => {
	const q = (req.query.q || '').trim();
	if (!q) return res.render('pages/search', { title: 'Search Crowdwide', pagePath: '/search', noIndex: true, query: '', users: [], communities: [], posts: [] });
	const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const regex = new RegExp(safe, 'i');
	const [users, communities, posts] = await Promise.all([
		User.find({ name: regex, isVerified: true }).limit(10).select('name bio profilePicture').lean(),
		Community.find({ $or: [{ name: regex }, { description: regex }, { category: regex }] }).limit(10).lean(),
		Post.find({ body: regex }).sort({ createdAt: -1 }).limit(20).populate('author', 'name profilePicture').populate('community', 'name slug').lean()
	]);
	res.render('pages/search', { title: `“${q}” on Crowdwide`, pagePath: '/search', noIndex: true, query: q, users, communities, posts });
};

exports.infoPage = (req, res) => {
	const pages = {
		'/about': { title: 'About Crowdwide', heading: 'The internet can feel human again.', intro: 'Crowdwide is a social discovery platform for people who want more signal, more context, and more room for new voices.', sections: [['Our idea', 'The best communities are not built around reach. They are built around recognition: the feeling that someone else is paying attention to the same fascinating thing you are.'], ['Our promise', 'We are building tools that reward curiosity, thoughtful participation, and the quality of a connection over the size of a following.']] },
		'/about/developer': { title: 'About the developer', heading: 'Built with care, in public.', intro: 'Crowdwide is an independent project focused on making online discovery feel generous and useful again.', sections: [['A small team mindset', 'Every feature starts with a simple question: does this help people find each other and make something worth returning to?'], ['Get in touch', 'For product feedback, accessibility concerns, or partnership ideas, contact the Crowdwide team through the email configured for this deployment.']] },
		'/privacy': { title: 'Privacy policy', heading: 'Your data deserves context.', intro: 'This policy explains what Crowdwide collects, why it is needed, and the choices available to you.', sections: [['What we collect', 'We collect account details you provide, content you create, and limited technical information needed to keep the service secure and reliable.'], ['How we use it', 'We use this information to authenticate accounts, deliver verification messages, operate the service, prevent abuse, and improve the product.'], ['Your choices', 'You may request access, correction, export, or deletion of your account information by contacting the Crowdwide team.']] },
		'/terms': { title: 'Terms of use', heading: 'A few promises in both directions.', intro: 'These terms describe the expectations for using Crowdwide and the responsibilities we share as a community.', sections: [['Use with care', 'Do not use Crowdwide to harass, deceive, exploit, or harm people. Do not upload content you do not have the right to share.'], ['Your content', 'You retain ownership of the content you post. You give Crowdwide permission to display and process it only as needed to operate the service.'], ['The service', 'Crowdwide is evolving. Features may change, and we will make a reasonable effort to communicate material changes.']] },
		'/community-guidelines': { title: 'Community guidelines', heading: 'Make room for people.', intro: 'Crowdwide works when people can participate without being diminished, manipulated, or pushed out.', sections: [['Bring curiosity', 'Ask honest questions, share context, and disagree with ideas without attacking the people behind them.'], ['Protect boundaries', 'Respect privacy, consent, and the right of others to leave a conversation.'], ['Report problems', 'If something feels unsafe or clearly violates these guidelines, report it so the team can review it.']] },
		'/accessibility': { title: 'Accessibility', heading: 'Designed for more ways of being here.', intro: 'We want Crowdwide to be usable by as many people as possible across devices, abilities, and connection speeds.', sections: [['Our approach', 'We use semantic HTML, keyboard-friendly controls, readable contrast, responsive layouts, and meaningful labels as a baseline.'], ['Tell us what is missing', 'Accessibility is ongoing work. Please report a barrier with the page URL and a description of what happened so we can investigate.']] },
		'/contact': { title: 'Contact Crowdwide', heading: 'Bring us a thought.', intro: 'Questions, feedback, and thoughtful criticism are welcome.', sections: [['Product feedback', 'Tell us what you were trying to do, what happened, and what would have made the experience better.'], ['Safety and privacy', 'For account, privacy, or safety concerns, include enough detail for us to locate the issue without sending passwords or private credentials.']] }
	};
	const page = pages[req.path] || pages['/about'];
	res.render('pages/info', { ...page, pagePath: req.path, description: page.intro });
};

exports.robots = (req, res) => { res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /dashboard\nDisallow: /auth/\nSitemap: ${(process.env.APP_URL || 'http://localhost:3000')}/sitemap.xml`); };
exports.sitemap = (req, res) => { res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/about', '/about/developer', '/privacy', '/terms', '/community-guidelines', '/accessibility', '/contact', '/auth/login', '/auth/register'].map((path) => `<url><loc>${(process.env.APP_URL || 'http://localhost:3000')}${path}</loc></url>`).join('')}</urlset>`); };
