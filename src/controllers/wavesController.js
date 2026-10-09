const WavesLedgerEntry = require('../models/WavesLedgerEntry');
const User = require('../models/User');
const logger = require('../services/logger');
const { getWalletSummary, transferWaves } = require('../services/waves');
const { getAdFreePlans, purchaseAdFree, isAdFree } = require('../services/adFree');
const { ensureUsername, normalizeUsername, USERNAME_PATTERN } = require('../services/username');

exports.wallet = async (req, res) => {
  const [wallet, adFreeOffer, username, userDoc, transactions] = await Promise.all([
    getWalletSummary(req.session.user.id),
    getAdFreePlans(),
    ensureUsername(req.session.user.id).catch(() => ''),
    User.findById(req.session.user.id).select('adFreeUntil').lean(),
    WavesLedgerEntry.find({ user: req.session.user.id })
      .sort({ createdAt: -1, _id: -1 })
      .limit(50)
      .populate('relatedUser', 'name')
      .populate('community', 'name slug')
      .lean()
  ]);
  if (!wallet) {
    req.session.flash = { type: 'error', message: 'Your Waves wallet could not be found.' };
    return res.redirect('/dashboard');
  }
  res.render('pages/wallet', {
    title: 'Waves wallet',
    pagePath: '/wallet',
    noIndex: true,
    wallet,
    username: username || '',
    adFree: { ...adFreeOffer, active: isAdFree(userDoc), until: userDoc?.adFreeUntil || null },
    transactions
  });
};

exports.transfer = async (req, res) => {
  const backToWallet = () => res.redirect('/wallet');
  const recipientUsername = normalizeUsername(req.body.recipientUsername);
  const amount = Number(req.body.amount);
  if (!USERNAME_PATTERN.test(recipientUsername) || !Number.isFinite(amount) || amount <= 0) {
    req.session.flash = { type: 'error', message: 'Enter a recipient username and a positive Waves amount.' };
    return backToWallet();
  }

  try {
    const recipient = await User.findOne({ username: recipientUsername }).select('_id');
    if (!recipient) {
      req.session.flash = { type: 'error', message: 'No account was found with that username.' };
      return backToWallet();
    }
    await transferWaves({
      fromUserId: req.session.user.id,
      toUserId: recipient._id,
      amount,
      description: 'User transfer'
    });
    req.session.flash = { type: 'success', message: `${amount.toLocaleString()} Waves transferred.` };
  } catch (error) {
    logger.warn('Waves transfer could not be completed', { userId: req.session.user.id, error });
    const expected = /must be greater|cannot transfer|cannot exceed|daily transfer limit|insufficient|temporarily suspended|cannot receive|account was not found|limits are invalid/i.test(error.message);
    req.session.flash = {
      type: 'error',
      message: expected ? error.message : 'The transfer could not be completed. Please try again later.'
    };
  }
  return backToWallet();
};

exports.buyAdFree = async (req, res) => {
  try {
    const result = await purchaseAdFree({ userId: req.session.user.id, planId: String(req.body.plan || '') });
    req.session.flash = { type: 'success', message: `Ad-Free is active until ${new Date(result.adFreeUntil).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}.` };
  } catch (error) {
    logger.warn('Ad-Free purchase could not be completed', { userId: req.session.user.id, error });
    const expected = /not available|insufficient|not found|temporarily/i.test(error.message);
    req.session.flash = { type: 'error', message: expected ? error.message : 'The purchase could not be completed. Please try again later.' };
  }
  return res.redirect('/wallet');
};
