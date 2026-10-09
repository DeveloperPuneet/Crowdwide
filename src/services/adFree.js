const { randomUUID } = require('node:crypto');
const User = require('../models/User');
const SiteSetting = require('../models/SiteSetting');
const WavesLedgerEntry = require('../models/WavesLedgerEntry');
const logger = require('./logger');

const PLAN_DEFS = [
  { id: '1m', months: 1, label: '1 month', field: 'adFreePrice1Month' },
  { id: '4m', months: 4, label: '4 months', field: 'adFreePrice4Months' },
  { id: '12m', months: 12, label: '12 months', field: 'adFreePrice12Months' }
];

function isAdFree(user, now = new Date()) {
  return Boolean(user?.adFreeUntil && new Date(user.adFreeUntil) > now);
}

async function getAdFreePlans() {
  const settings = await SiteSetting.getSingleton();
  if (settings.adFreeEnabled === false) return { enabled: false, plans: [] };
  const plans = PLAN_DEFS.map((def) => ({
    id: def.id, months: def.months, label: def.label,
    price: Number(settings[def.field] ?? 0)
  })).filter((plan) => Number.isFinite(plan.price) && plan.price >= 1);
  const base = plans.find((plan) => plan.id === '1m');
  return {
    enabled: plans.length > 0,
    plans: plans.map((plan) => ({
      ...plan,
      savingsPercent: base && plan.months > 1 ? Math.max(0, Math.round((1 - plan.price / (base.price * plan.months)) * 100)) : 0
    }))
  };
}

function addMonths(date, months) {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

async function purchaseAdFree({ userId, planId, now = new Date() }) {
  const { enabled, plans } = await getAdFreePlans();
  const plan = plans.find((item) => item.id === planId);
  if (!enabled || !plan) throw new Error('That Ad-Free plan is not available.');

  const current = await User.findById(userId).select('adFreeUntil wavesBalance isVerified').lean();
  if (!current || !current.isVerified) throw new Error('Your account was not found.');
  if (Number(current.wavesBalance || 0) < plan.price) throw new Error('Insufficient Waves for this plan.');
  const previousUntil = current.adFreeUntil && new Date(current.adFreeUntil) > now ? new Date(current.adFreeUntil) : null;
  const newUntil = addMonths(previousUntil || now, plan.months);

  const ledger = await WavesLedgerEntry.create({
    user: userId, amount: -plan.price, balanceAfter: 0, type: 'spend', status: 'pending',
    description: `Ad-Free plan (${plan.label})`,
    reason: `Ad-Free until ${newUntil.toISOString().slice(0, 10)}.`,
    actor: userId, referenceType: 'ad-free', rewardKey: `ad-free:${randomUUID()}`
  });
  let charged = null;
  try {
    charged = await User.findOneAndUpdate({
      _id: userId,
      wavesBalance: { $gte: plan.price },
      adFreeUntil: current.adFreeUntil ?? null,
      $or: [{ wavesSuspendedUntil: null }, { wavesSuspendedUntil: { $lte: now } }]
    }, {
      $set: { adFreeUntil: newUntil },
      $inc: { wavesBalance: -plan.price, wavesTotalSpent: plan.price }
    }, { new: true }).select('wavesBalance adFreeUntil');
  } catch (error) {
    ledger.status = 'reversed';
    await ledger.save().catch((e) => logger.error('Ad-Free ledger reversal failed', e));
    throw error;
  }
  if (!charged) {
    ledger.status = 'reversed';
    await ledger.save();
    throw new Error('Insufficient Waves, or your plan changed while paying. Please try again.');
  }
  ledger.status = 'posted';
  ledger.balanceAfter = charged.wavesBalance;
  await ledger.save();
  return { plan, adFreeUntil: charged.adFreeUntil, balance: charged.wavesBalance };
}

module.exports = { PLAN_DEFS, isAdFree, getAdFreePlans, purchaseAdFree, addMonths };
