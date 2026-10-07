const WavesLedgerEntry = require('../models/WavesLedgerEntry');
const User = require('../models/User');
const logger = require('../services/logger');
const { getWalletSummary, transferWaves } = require('../services/waves');

exports.wallet = async (req, res) => {
  const [wallet, transactions] = await Promise.all([
    getWalletSummary(req.session.user.id),
    WavesLedgerEntry.find({ user: req.session.user.id })
      .sort({ createdAt: -1, _id: -1 })
      .limit(50)
      .populate('relatedUser', 'name')
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
    transactions
  });
};

exports.transfer = async (req, res) => {
  const backToWallet = () => res.redirect('/wallet');
  const recipientEmail = String(req.body.recipientEmail || '').trim().toLowerCase();
  const amount = Number(req.body.amount);
  if (!recipientEmail || !Number.isFinite(amount) || amount <= 0) {
    req.session.flash = { type: 'error', message: 'Enter a recipient email and a positive Waves amount.' };
    return backToWallet();
  }

  try {
    const recipient = await User.findOne({ email: recipientEmail }).select('_id');
    if (!recipient) {
      req.session.flash = { type: 'error', message: 'No account was found for that email address.' };
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
