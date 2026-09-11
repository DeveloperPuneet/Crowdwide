const router = require('express').Router();
const controller = require('../controllers/authController');
const { authLimiter } = require('../middleware/security');
const twoFactorController = require('../controllers/twoFactorController');

router.get('/login', controller.loginPage);
router.post('/login', authLimiter, controller.login);
router.get('/register', controller.registerPage);
router.post('/register', authLimiter, controller.register);
router.get('/verify', controller.verifyPage);
router.post('/verify', controller.verify);
router.get('/forgot-password', controller.forgotPage);
router.post('/forgot-password', authLimiter, controller.forgot);
router.get('/reset', controller.resetPage);
router.post('/reset', authLimiter, controller.reset);
router.get('/2fa', (req, res) => res.render('pages/login-2fa', { title: 'Verify sign in' }));
router.post('/2fa', authLimiter, twoFactorController.verifyLogin);
router.post('/logout', controller.logout);

module.exports = router;
