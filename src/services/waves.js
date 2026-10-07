const User = require('../models/User');
const WavesLedgerEntry = require('../models/WavesLedgerEntry');
const SiteSetting = require('../models/SiteSetting');

function normalizeAmount(value, fieldName = 'amount') {
  const amount = Number(value);
  if (!Number.isFinite(amount)) throw new Error(`${fieldName} must be a number.`);
  return amount;
}

async function updateWavesBalance({ userId, delta, type = 'adjustment', description = '', reason = '', actorId = null, relatedUserId = null, referenceType = '', referenceId = null, status = 'posted' }) {
  const amount = normalizeAmount(delta, 'delta');
  const user = await User.findById(userId);
  if (!user) throw new Error('User not found for Waves update.');

  const nextBalance = Number(((user.wavesBalance || 0) + amount).toFixed(6));
  if (nextBalance < 0) throw new Error('Insufficient Waves balance.');

  user.wavesBalance = nextBalance;
  if (amount > 0) {
    user.wavesTotalEarned = Number(((user.wavesTotalEarned || 0) + amount).toFixed(6));
  }
  if (amount < 0) {
    user.wavesTotalSpent = Number(((user.wavesTotalSpent || 0) + Math.abs(amount)).toFixed(6));
  }
  await user.save();

  await WavesLedgerEntry.create({
    user: userId,
    relatedUser: relatedUserId || null,
    amount,
    balanceAfter: user.wavesBalance,
    type,
    status,
    description: String(description || '').trim().slice(0, 200),
    reason: String(reason || '').trim().slice(0, 500),
    actor: actorId || null,
    referenceType: String(referenceType || '').trim().slice(0, 40),
    referenceId: referenceId || null
  });

  return user;
}

async function creditWaves({ userId, amount, description, reason, actorId, referenceType, referenceId }) {
  return updateWavesBalance({
    userId,
    delta: normalizeAmount(amount, 'amount'),
    type: 'earn',
    description,
    reason,
    actorId,
    referenceType,
    referenceId,
    status: 'posted'
  });
}

async function debitWaves({ userId, amount, description, reason, actorId, referenceType, referenceId }) {
  const value = normalizeAmount(amount, 'amount');
  return updateWavesBalance({
    userId,
    delta: -Math.abs(value),
    type: 'spend',
    description,
    reason,
    actorId,
    referenceType,
    referenceId,
    status: 'posted'
  });
}

async function transferWaves({ fromUserId, toUserId, amount, description = 'Transfer', actorId = null }) {
  const value = normalizeAmount(amount, 'amount');
  if (value <= 0) throw new Error('Transfer amount must be greater than zero.');
  if (String(fromUserId) === String(toUserId)) throw new Error('A user cannot transfer Waves to themselves.');

  await updateWavesBalance({
    userId: fromUserId,
    delta: -Math.abs(value),
    type: 'transfer-out',
    description: String(description || 'Transfer').trim().slice(0, 200),
    reason: 'Outgoing transfer',
    actorId,
    relatedUserId: toUserId
  });

  const receiver = await updateWavesBalance({
    userId: toUserId,
    delta: Math.abs(value),
    type: 'transfer-in',
    description: String(description || 'Transfer').trim().slice(0, 200),
    reason: 'Incoming transfer',
    actorId,
    relatedUserId: fromUserId
  });

  return { amount: value, recipient: receiver };
}

async function adjustWaves({ userId, delta, reason, actorId, referenceType = 'admin', referenceId = null }) {
  return updateWavesBalance({
    userId,
    delta: normalizeAmount(delta, 'delta'),
    type: 'adjustment',
    description: 'Admin Waves adjustment',
    reason: String(reason || 'Administrative adjustment').trim().slice(0, 500),
    actorId,
    referenceType,
    referenceId,
    status: 'posted'
  });
}

async function getWalletSummary(userId) {
  const user = await User.findById(userId).select('wavesBalance wavesTotalEarned wavesTotalSpent').lean();
  if (!user) return null;
  return {
    balance: Number(user.wavesBalance || 0),
    totalEarned: Number(user.wavesTotalEarned || 0),
    totalSpent: Number(user.wavesTotalSpent || 0)
  };
}

async function rewardWavesForAction({ userId, action, referenceType, referenceId }) {
  const rewardConfigs = {
    post: { configKey: 'wavesPostReward', description: 'Published post reward' },
    comment: { configKey: 'wavesCommentReward', description: 'Comment reward' }
  };
  const rewardConfig = rewardConfigs[action];
  if (!rewardConfig) throw new Error(`Unsupported Waves reward action: ${action}`);

  const settings = await SiteSetting.getSingleton();
  const range = settings[rewardConfig.configKey] || {};
  const minimum = normalizeAmount(range.minimum ?? 1, `${action} reward minimum`);
  const maximum = normalizeAmount(range.maximum ?? 3, `${action} reward maximum`);
  const dailyLimit = normalizeAmount(settings.wavesDailyEarningLimit ?? 20, 'daily earning limit');
  if (minimum < 0 || maximum < minimum || dailyLimit < 0) {
    throw new Error('Waves reward configuration is invalid.');
  }
  if (maximum === 0 || dailyLimit === 0) return { amount: 0, balance: null };

  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const earnedToday = await WavesLedgerEntry.aggregate([
    { $match: { user: userId, type: 'earn', status: 'posted', createdAt: { $gte: dayStart } } },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]);
  const remainingLimit = Math.max(0, dailyLimit - Number(earnedToday[0]?.total || 0));
  if (!remainingLimit) return { amount: 0, balance: null };

  const randomValue = minimum + (Math.random() * (maximum - minimum));
  const amount = Number(Math.min(remainingLimit, randomValue).toFixed(6));
  if (amount <= 0) return { amount: 0, balance: null };

  const user = await creditWaves({
    userId,
    amount,
    description: rewardConfig.description,
    reason: `Platform reward for ${action}`,
    referenceType,
    referenceId
  });
  return { amount, balance: user.wavesBalance };
}

module.exports = {
  creditWaves,
  debitWaves,
  transferWaves,
  adjustWaves,
  getWalletSummary,
  updateWavesBalance,
  rewardWavesForAction
};
