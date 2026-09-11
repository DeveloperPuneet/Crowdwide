const User = require('../models/User');
const Post = require('../models/Post');
const Community = require('../models/Community');

const fallbackCommunities = [
	{ name: 'Independent makers', members: 0, description: 'A home for people building with their hands and minds.' },
	{ name: 'Late-night learners', members: 0, description: 'Curiosity does not keep office hours.' },
	{ name: 'Small joys', members: 0, description: 'The ordinary things that make a day feel full.' }
];

async function getLiveStats() {
	if (!User.db.readyState) {
		return { members: 0, posts: 0, communities: 0, communitiesAreLive: false, topCommunities: fallbackCommunities };
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
		topCommunities: topCommunities.length ? topCommunities.map((community) => ({
			name: community.name,
			members: community.membersCount || 0,
			description: community.description
		})) : fallbackCommunities
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
		res.render('pages/home', { title: 'A fair chance at discovery', pagePath: '/', stats: { members: 0, posts: 0, communities: 0, communitiesAreLive: false, topCommunities: fallbackCommunities } });
	}
};

exports.dashboard = (req, res) => res.render('pages/dashboard', { title: 'Your Crowdwide', pagePath: '/dashboard', noIndex: true });

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
