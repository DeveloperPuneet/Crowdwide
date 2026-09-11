const router = require('express').Router();
const controller = require('../controllers/authController');

router.get('/login', controller.loginPage);
router.post('/login', controller.login);
router.get('/register', controller.registerPage);
router.post('/register', controller.register);
router.get('/verify', controller.verifyPage);
router.post('/verify', controller.verify);
router.get('/forgot-password', controller.forgotPage);
router.post('/forgot-password', controller.forgot);
router.get('/reset', controller.resetPage);
router.post('/reset', controller.reset);
router.post('/logout', controller.logout);

module.exports = router;
