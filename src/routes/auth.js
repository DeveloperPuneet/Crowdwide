const router = require('express').Router();
const controller = require('../controllers/authController');
const appealController = require('../controllers/appealController');
const { authLimiter, emailLimiter } = require('../middleware/security');
const twoFactorController = require('../controllers/twoFactorController');
const oauthController = require('../controllers/oauthController');

router.get('/login', controller.loginPage);
router.post('/login', authLimiter, controller.login);
router.get('/register', controller.registerPage);
router.post('/register', authLimiter, controller.register);
router.get('/verify', controller.verifyPage);
router.post('/verify', authLimiter, controller.verify);
router.get('/verify-email/:id/:token', controller.verifyLinkPage);
router.post('/verify-email/:id/:token', authLimiter, controller.verifyLink);
router.post('/resend', authLimiter, emailLimiter, controller.resendCode);
router.get('/forgot-password', controller.forgotPage);
router.post('/forgot-password', authLimiter, emailLimiter, controller.forgot);
router.get('/reset', controller.resetPage);
router.post('/reset', authLimiter, controller.reset);
router.get('/2fa', (req, res) => res.render('pages/login-2fa', { title: 'Verify sign in' }));
router.post('/2fa', authLimiter, twoFactorController.verifyLogin);
router.get('/appeal', appealController.publicAppealPage);
router.post('/appeal', authLimiter, appealController.submitPublicAppeal);
router.post('/logout', controller.logout);

// Continue with Google / GitHub. The explicit provider list keeps unknown
// /auth/* paths falling through to the normal 404.
router.get('/social/confirm', oauthController.confirmPage);
router.post('/social/confirm', authLimiter, oauthController.confirm);
router.get('/:provider(google|github)', oauthController.start);
router.get('/:provider(google|github)/callback', authLimiter, oauthController.callback);

module.exports = router;
