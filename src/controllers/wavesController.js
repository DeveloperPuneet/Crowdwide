const WavesLedgerEntry = require('../models/WavesLedgerEntry');
const { getWalletSummary } = require('../services/waves');

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
