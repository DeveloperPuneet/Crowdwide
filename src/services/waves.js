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
  if (amount < 0 && type !== 'adjustment' && user.wavesSuspendedUntil && user.wavesSuspendedUntil > new Date()) {
    throw new Error('Your Waves account is temporarily held from spending.');
  }

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

  const [settings, sender, recipient] = await Promise.all([
    SiteSetting.getSingleton(),
    User.findById(fromUserId),
    User.findById(toUserId)
  ]);
  if (!sender) throw new Error('Sender account was not found.');
  if (!recipient) throw new Error('Recipient account was not found.');
  const now = new Date();
  if (sender.wavesSuspendedUntil && sender.wavesSuspendedUntil > now) {
    throw new Error('Your Waves account is temporarily suspended from transfers.');
  }
  if (recipient.wavesSuspendedUntil && recipient.wavesSuspendedUntil > now) {
    throw new Error('The recipient cannot receive Waves right now.');
  }

  const maxTransfer = normalizeAmount(settings.wavesMaxTransferAmount ?? 100, 'maximum transfer amount');
  const dailyLimit = normalizeAmount(settings.wavesDailyTransferLimit ?? 500, 'daily transfer limit');
  if (maxTransfer < 0 || dailyLimit < 0) throw new Error('Waves transfer limits are invalid.');
  if (value > maxTransfer) throw new Error(`A single transfer cannot exceed ${maxTransfer} Waves.`);

  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const transferredToday = await WavesLedgerEntry.aggregate([
    { $match: { user: fromUserId, type: 'transfer-out', status: 'posted', createdAt: { $gte: dayStart } } },
    { $group: { _id: null, total: { $sum: { $abs: '$amount' } } } }
  ]);
  const sentToday = Number(transferredToday[0]?.total || 0);
  if (sentToday + value > dailyLimit) {
    throw new Error(`Your daily transfer limit is ${dailyLimit} Waves.`);
  }

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

async function rewardWavesForAction({ userId, actorId = null, action, referenceType, referenceId }) {
  const rewardConfigs = {
    post: { configKey: 'wavesPostReward', description: 'Published post reward' },
    comment: { configKey: 'wavesCommentReward', description: 'Comment reward' },
    receivedLike: { configKey: 'wavesLikeReward', description: 'Received like reward' },
    receivedComment: { configKey: 'wavesReceivedCommentReward', description: 'Received comment reward' },
    communityJoin: { configKey: 'wavesCommunityJoinReward', description: 'Community join reward' },
    communityCreate: { configKey: 'wavesCommunityCreateReward', description: 'Community creation reward' },
    questCompletion: { configKey: 'wavesQuestCompletionReward', description: 'Quest completion reward' }
  };
  const rewardConfig = rewardConfigs[action];
  if (!rewardConfig) throw new Error(`Unsupported Waves reward action: ${action}`);
  if (['receivedLike', 'receivedComment'].includes(action) && actorId && String(userId) === String(actorId)) {
    return { amount: 0, balance: null };
  }

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

  const rewardKey = `reward:${userId}:${action}:${referenceType || ''}:${referenceId || ''}:${actorId || ''}`;
  let claim;
  try {
    claim = await WavesLedgerEntry.create({
      user: userId,
      amount,
      type: 'earn',
      status: 'pending',
      description: rewardConfig.description,
      reason: `Platform reward for ${action}`,
      actor: actorId || null,
      referenceType: String(referenceType || '').trim().slice(0, 40),
      referenceId: referenceId || null,
      rewardKey
    });
  } catch (error) {
    if (error?.code === 11000) return { amount: 0, balance: null };
    throw error;
  }

  try {
    user = await User.findById(userId);
    if (!user) throw new Error('User not found for Waves reward.');
    if (user.wavesSuspendedUntil && user.wavesSuspendedUntil > now) {
      throw new Error('Your Waves account is temporarily held from earning.');
    }
    user.wavesBalance = Number(((user.wavesBalance || 0) + amount).toFixed(6));
    user.wavesTotalEarned = Number(((user.wavesTotalEarned || 0) + amount).toFixed(6));
    await user.save();
  } catch (error) {
    claim.status = 'reversed';
    claim.reason = `${claim.reason}; reward failed before posting`.slice(0, 500);
    await claim.save();
    throw error;
  }
  claim.balanceAfter = user.wavesBalance;
  claim.status = 'posted';
  await claim.save();
  return { amount, balance: user.wavesBalance };
}

async function getReciprocalRewardSignals(now = new Date()) {
  const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const rows = await WavesLedgerEntry.aggregate([
    { $match: {
      type: 'earn',
      status: 'posted',
      description: { $in: ['Received like reward', 'Received comment reward'] },
      referenceType: { $in: ['post', 'post-comment'] },
      actor: { $ne: null },
      amount: { $gt: 0 },
      createdAt: { $gte: since },
      $expr: { $ne: ['$actor', '$user'] }
    } },
    { $project: {
      accountA: { $cond: [{ $lt: ['$actor', '$user'] }, '$actor', '$user'] },
      accountB: { $cond: [{ $lt: ['$actor', '$user'] }, '$user', '$actor'] },
      actor: 1,
      amount: 1,
      referenceId: 1,
      day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } }
    } },
    { $group: {
      _id: { accountA: '$accountA', accountB: '$accountB' },
      totalRewards: { $sum: 1 },
      rewardsFromA: { $sum: { $cond: [{ $eq: ['$actor', '$accountA'] }, 1, 0] } },
      rewardsFromB: { $sum: { $cond: [{ $eq: ['$actor', '$accountB'] }, 1, 0] } },
      uniqueTargets: { $addToSet: '$referenceId' },
      activeDays: { $addToSet: '$day' },
      totalWaves: { $sum: '$amount' }
    } },
    { $match: {
      totalRewards: { $gte: 8 },
      rewardsFromA: { $gte: 3 },
      rewardsFromB: { $gte: 3 },
      $expr: {
        $and: [
          { $gte: [{ $size: '$uniqueTargets' }, 6] },
          { $gte: [{ $size: '$activeDays' }, 2] }
        ]
      }
    } },
    { $sort: { totalRewards: -1 } },
    { $limit: 50 }
  ]);
  if (!rows.length) return [];

  const userIds = [...new Set(rows.flatMap((row) => [String(row._id.accountA), String(row._id.accountB)]))];
  const users = await User.find({ _id: { $in: userIds } }).select('name').lean();
  const names = new Map(users.map((user) => [String(user._id), user.name]));
  return rows.map((row) => ({
    accountA: { id: String(row._id.accountA), name: names.get(String(row._id.accountA)) || 'Unknown account' },
    accountB: { id: String(row._id.accountB), name: names.get(String(row._id.accountB)) || 'Unknown account' },
    totalRewards: Number(row.totalRewards || 0),
    rewardsFromA: Number(row.rewardsFromA || 0),
    rewardsFromB: Number(row.rewardsFromB || 0),
    activeDays: row.activeDays.length,
    uniqueTargets: row.uniqueTargets.length,
    totalWaves: Number(row.totalWaves || 0)
  }));
}

module.exports = {
  creditWaves,
  debitWaves,
  transferWaves,
  adjustWaves,
  getWalletSummary,
  updateWavesBalance,
  rewardWavesForAction,
  getReciprocalRewardSignals
};
