const router = require('express').Router();
const controller = require('../controllers/webController');
const { requireAuth, requireVerified } = require('../middleware/auth');

router.get('/', controller.home);
router.get('/dashboard', requireAuth, requireVerified, controller.dashboard);

module.exports = router;
