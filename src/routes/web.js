const router = require('express').Router();
const controller = require('../controllers/webController');
const { requireAuth, requireVerified } = require('../middleware/auth');

router.get('/', controller.home);
router.get('/dashboard', requireAuth, requireVerified, controller.dashboard);
['/about', '/about/developer', '/privacy', '/terms', '/community-guidelines', '/accessibility', '/contact'].forEach((path) => router.get(path, controller.infoPage));
router.get('/robots.txt', controller.robots);
router.get('/sitemap.xml', controller.sitemap);

module.exports = router;
