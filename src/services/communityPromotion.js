const { randomUUID } = require('node:crypto');
const User = require('../models/User');
const Community = require('../models/Community');
const SiteSetting = require('../models/SiteSetting');
const WavesLedgerEntry = require('../models/WavesLedgerEntry');
const logger = require('./logger');

async function getCommunityPromotionOffer() {
  const settings = await SiteSetting.getSingleton();
  if (!settings.communityPromotionEnabled) return null;
  return {
    wavesCost: Number(settings.communityPromotionWavesCost ?? 50),
    durationHours: Number(settings.communityPromotionDurationHours ?? 48)
  };
}

async function getActiveCommunityPromotions({ now = new Date() } = {}) {
  const communities = await Community.find({
    isPrivate: false,
    promotionStatus: 'active',
    promotionUntil: { $gt: now }
  }).sort({ promotionStartedAt: -1 }).lean();
  if (!communities.length) return [];
  const ownerIds = [...new Set(communities.map((community) => String(community.owner)))];
  const eligibleOwners = await User.find({
    _id: { $in: ownerIds },
    isVerified: true,
    $and: [
      { $or: [{ suspendedUntil: null }, { suspendedUntil: { $lte: now } }] },
      { $or: [{ postingRestrictedUntil: null }, { postingRestrictedUntil: { $lte: now } }] },
      { $or: [{ wavesSuspendedUntil: null }, { wavesSuspendedUntil: { $lte: now } }] }
    ]
  }).select('_id').lean();
  const eligibleIds = new Set(eligibleOwners.map((owner) => String(owner._id)));
  return communities
    .filter((community) => eligibleIds.has(String(community.owner)))
    .map((community) => ({ ...community, isPromoted: true }));
}

async function promoteCommunity({ communityId, userId, now = new Date() }) {
  const offer = await getCommunityPromotionOffer();
  if (!offer) throw new Error('Community promotion is currently unavailable.');
  if (!Number.isFinite(offer.wavesCost) || offer.wavesCost < 1 || offer.wavesCost > 10000
    || !Number.isFinite(offer.durationHours) || offer.durationHours < 1 || offer.durationHours > 168) {
    throw new Error('Community promotion is not configured correctly.');
  }

  const purchaseKey = randomUUID();
  const community = await Community.findOneAndUpdate({
    _id: communityId,
    owner: userId,
    isPrivate: false,
    $or: [
      { promotionStatus: { $in: ['disabled', 'expired'] } },
      { promotionStatus: 'active', promotionUntil: { $lte: now } },
      { promotionStatus: { $exists: false } }
    ]
  }, {
    $set: { promotionStatus: 'pending', promotionPurchaseKey: purchaseKey }
  }, { new: true }).select('_id');

  if (!community) {
    const existing = await Community.findById(communityId).select('owner isPrivate promotionStatus promotionUntil').lean();
    if (!existing || String(existing.owner) !== String(userId)) {
      throw new Error('Only the community owner can promote this community.');
    }
    if (existing.isPrivate) throw new Error('Private communities cannot be promoted.');
    if (existing.promotionStatus === 'pending') throw new Error('This community promotion is already being processed.');
    throw new Error('This community already has an active promotion.');
  }

  let chargedUser = null;
  let ledgerEntry = null;
  let debitAttempted = false;
  let debitOutcomeKnown = false;
  try {
    ledgerEntry = await WavesLedgerEntry.create({
      user: userId,
      amount: -offer.wavesCost,
      balanceAfter: 0,
      type: 'spend',
      status: 'pending',
      description: 'Community promotion',
      reason: `Promoted community for ${offer.durationHours} hours.`,
      actor: userId,
      referenceType: 'community-promotion',
      referenceId: communityId,
      rewardKey: `community-promotion:${purchaseKey}`
    });

    debitAttempted = true;
    chargedUser = await User.findOneAndUpdate({
      _id: userId,
      isVerified: true,
      wavesBalance: { $gte: offer.wavesCost },
      $or: [
        { wavesSuspendedUntil: null },
        { wavesSuspendedUntil: { $lte: now } }
      ],
      $and: [
        { $or: [{ suspendedUntil: null }, { suspendedUntil: { $lte: now } }] },
        { $or: [{ postingRestrictedUntil: null }, { postingRestrictedUntil: { $lte: now } }] }
      ]
    }, {
      $inc: { wavesBalance: -offer.wavesCost, wavesTotalSpent: offer.wavesCost }
    }, { new: true }).select('wavesBalance');
    debitOutcomeKnown = true;

    if (!chargedUser) {
      ledgerEntry.status = 'reversed';
      ledgerEntry.reason = 'Promotion was not charged because the wallet update found no eligible balance.';
      await ledgerEntry.save();
      const owner = await User.findById(userId).select('wavesBalance wavesSuspendedUntil suspendedUntil isVerified').lean();
      if (owner?.wavesSuspendedUntil && owner.wavesSuspendedUntil > now) {
        throw new Error('Your Waves account is temporarily held from spending.');
      }
      if (owner?.suspendedUntil && owner.suspendedUntil > now) {
        throw new Error('Suspended accounts cannot promote communities.');
      }
      if (owner?.postingRestrictedUntil && owner.postingRestrictedUntil > now) {
        throw new Error('Accounts with an active posting restriction cannot promote communities.');
      }
      if (!owner?.isVerified) throw new Error('A verified account is required to promote a community.');
      throw new Error('You do not have enough Waves for this promotion.');
    }

    ledgerEntry.balanceAfter = chargedUser.wavesBalance;
    ledgerEntry.status = 'posted';
    await ledgerEntry.save();

    const endsAt = new Date(now.getTime() + offer.durationHours * 60 * 60 * 1000);
    const activated = await Community.updateOne({
      _id: communityId,
      owner: userId,
      isPrivate: false,
      promotionStatus: 'pending',
      promotionPurchaseKey: purchaseKey
    }, {
      $set: {
        promotionStatus: 'active',
        promotionStartedAt: now,
        promotionUntil: endsAt,
        promotionWavesCost: offer.wavesCost
      }
    });
    if (activated.modifiedCount !== 1) throw new Error('The community changed before its promotion could be activated.');

    return { wavesCost: offer.wavesCost, durationHours: offer.durationHours, endsAt };
  } catch (error) {
    if (debitAttempted && !debitOutcomeKnown) {
      logger.error('Community promotion Waves debit outcome is unknown and requires reconciliation', {
        userId, communityId, purchaseKey, error
      });
      throw new Error('The promotion payment needs review. Please contact support before retrying.');
    }
    if (chargedUser) {
      try {
        const refundedUser = await User.findOneAndUpdate({ _id: userId }, {
          $inc: { wavesBalance: offer.wavesCost, wavesTotalSpent: -offer.wavesCost }
        }, { new: true }).select('wavesBalance');
        if (!refundedUser) throw new Error('The account was not available for a Waves refund.');
        ledgerEntry.status = 'reversed';
        ledgerEntry.reason = 'Community promotion activation failed; Waves refunded.';
        await ledgerEntry.save();
        await WavesLedgerEntry.create({
          user: userId,
          amount: offer.wavesCost,
          balanceAfter: refundedUser.wavesBalance,
          type: 'refund',
          status: 'posted',
          description: 'Community promotion refund',
          reason: 'Promotion could not be activated.',
          actor: userId,
          referenceType: 'community-promotion',
          referenceId: communityId,
          rewardKey: `community-promotion-refund:${purchaseKey}`
        });
      } catch (refundError) {
        logger.error('Community promotion failed and its Waves refund needs review', {
          userId, communityId, purchaseKey, error, refundError
        });
        throw new Error('The promotion could not be completed. Please contact support to review the Waves transaction.');
      }
    }

    await Community.updateOne({
      _id: communityId,
      promotionStatus: 'pending',
      promotionPurchaseKey: purchaseKey
    }, {
      $set: { promotionStatus: 'disabled' },
      $unset: { promotionPurchaseKey: 1 }
    });
    throw error;
  }
}

module.exports = { getCommunityPromotionOffer, getActiveCommunityPromotions, promoteCommunity };
