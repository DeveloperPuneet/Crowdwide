const { randomUUID } = require('node:crypto');
const User = require('../models/User');
const Post = require('../models/Post');
const Community = require('../models/Community');
const SiteSetting = require('../models/SiteSetting');
const WavesLedgerEntry = require('../models/WavesLedgerEntry');
const logger = require('./logger');

async function getPostPromotionOffer() {
  const settings = await SiteSetting.getSingleton();
  if (!settings.postPromotionEnabled) return null;
  return {
    wavesCost: Number(settings.postPromotionWavesCost ?? 25),
    durationHours: Number(settings.postPromotionDurationHours ?? 24)
  };
}

async function promotePost({ postId, userId, now = new Date() }) {
  const offer = await getPostPromotionOffer();
  if (!offer) throw new Error('Post promotion is currently unavailable.');
  if (!Number.isFinite(offer.wavesCost) || offer.wavesCost < 1
    || !Number.isFinite(offer.durationHours) || offer.durationHours < 1) {
    throw new Error('Post promotion is not configured correctly.');
  }

  const purchaseKey = randomUUID();
  const post = await Post.findOneAndUpdate({
    _id: postId,
    author: userId,
    status: 'published',
    moderationStatus: { $in: ['unreviewed', 'good'] },
    replyTo: null,
    $or: [
      { boostStatus: { $in: ['disabled', 'expired'] } },
      { boostStatus: 'active', boostUntil: { $lte: now } },
      { boostStatus: { $exists: false } }
    ]
  }, {
    $set: { boostStatus: 'pending', boostPurchaseKey: purchaseKey }
  }, { new: true }).select('community body media').lean();

  if (!post) {
    const existing = await Post.findById(postId).select('author status moderationStatus boostStatus boostUntil').lean();
    if (!existing || String(existing.author) !== String(userId)) throw new Error('Only the author of a published post can promote it.');
    if (existing.status !== 'published' || !['unreviewed', 'good'].includes(existing.moderationStatus)) {
      throw new Error('Only published posts that have not been flagged for review can be promoted.');
    }
    if (existing.boostStatus === 'pending') throw new Error('This post promotion is already being processed.');
    throw new Error('This post already has an active promotion.');
  }

  let chargedUser = null;
  let ledgerEntry = null;
  try {
    if (!String(post.body || '').trim() && !(post.media || []).length) {
      throw new Error('Add text or media to the post before promoting it.');
    }

    if (post.community) {
      const publicCommunity = await Community.findOne({ _id: post.community, isPrivate: false }).select('_id').lean();
      if (!publicCommunity) throw new Error('Posts in private or unavailable communities cannot be promoted.');
    }

    chargedUser = await User.findOneAndUpdate({
      _id: userId,
      wavesBalance: { $gte: offer.wavesCost },
      $or: [
        { wavesSuspendedUntil: null },
        { wavesSuspendedUntil: { $lte: now } }
      ]
    }, {
      $inc: { wavesBalance: -offer.wavesCost, wavesTotalSpent: offer.wavesCost }
    }, { new: true }).select('wavesBalance');

    if (!chargedUser) {
      const account = await User.findById(userId).select('wavesBalance wavesSuspendedUntil').lean();
      if (account?.wavesSuspendedUntil && account.wavesSuspendedUntil > now) {
        throw new Error('Your Waves account is temporarily held from spending.');
      }
      throw new Error('You do not have enough Waves for this promotion.');
    }

    ledgerEntry = await WavesLedgerEntry.create({
      user: userId,
      amount: -offer.wavesCost,
      balanceAfter: chargedUser.wavesBalance,
      type: 'spend',
      status: 'posted',
      description: 'Post promotion',
      reason: `Promoted post for ${offer.durationHours} hours.`,
      actor: userId,
      referenceType: 'post-promotion',
      referenceId: postId,
      rewardKey: `post-promotion:${purchaseKey}`
    });

    const endsAt = new Date(now.getTime() + offer.durationHours * 60 * 60 * 1000);
    const activated = await Post.updateOne({
      _id: postId,
      boostStatus: 'pending',
      boostPurchaseKey: purchaseKey,
      status: 'published',
      moderationStatus: { $in: ['unreviewed', 'good'] },
      replyTo: null
    }, {
      $set: {
        boostStatus: 'active',
        boostStartedAt: now,
        boostUntil: endsAt,
        boostWavesCost: offer.wavesCost
      }
    });
    if (activated.modifiedCount !== 1) throw new Error('The post changed before its promotion could be activated.');

    require('./feedService').clearFeedCache();
    return { wavesCost: offer.wavesCost, durationHours: offer.durationHours, endsAt };
  } catch (error) {
    if (chargedUser) {
      try {
        const refundedUser = await User.findOneAndUpdate({ _id: userId }, {
          $inc: { wavesBalance: offer.wavesCost, wavesTotalSpent: -offer.wavesCost }
        }, { new: true }).select('wavesBalance');
        if (!refundedUser) throw new Error('The account was not available for a Waves refund.');
        if (ledgerEntry) {
          ledgerEntry.status = 'reversed';
          ledgerEntry.reason = 'Promotion activation failed; Waves refunded.';
          await ledgerEntry.save();
          await WavesLedgerEntry.create({
            user: userId,
            amount: offer.wavesCost,
            balanceAfter: refundedUser.wavesBalance,
            type: 'refund',
            status: 'posted',
            description: 'Post promotion refund',
            reason: 'Promotion could not be activated.',
            actor: userId,
            referenceType: 'post-promotion',
            referenceId: postId,
            rewardKey: `post-promotion-refund:${purchaseKey}`
          });
        }
      } catch (refundError) {
        logger.error('Post promotion failed and its Waves refund needs review', {
          userId, postId, purchaseKey, error, refundError
        });
        throw new Error('The promotion could not be completed. Please contact support to review the Waves transaction.');
      }
    }

    await Post.updateOne({
      _id: postId,
      boostStatus: 'pending',
      boostPurchaseKey: purchaseKey
    }, {
      $set: { boostStatus: 'disabled' },
      $unset: { boostPurchaseKey: 1 }
    });
    throw error;
  }
}

module.exports = { getPostPromotionOffer, promotePost };
