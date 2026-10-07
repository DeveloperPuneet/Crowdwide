const test = require('node:test');
const assert = require('node:assert/strict');

const { calculateRevenueShares, calculateCommunityAdShare } = require('../src/services/communityRevenue');

test('revenue shares split net minor units and reconcile exactly', () => {
  assert.deepEqual(calculateRevenueShares({
    grossRevenueMinorUnits: 10001,
    deductionsMinorUnits: 1001,
    communityOwnerSharePercent: 60
  }), {
    grossRevenueMinorUnits: 10001,
    deductionsMinorUnits: 1001,
    netRevenueMinorUnits: 9000,
    communityOwnerSharePercent: 60,
    communityOwnerShareMinorUnits: 5400,
    crowdwideSharePercent: 40,
    crowdwideShareMinorUnits: 3600
  });
});

test('share calculation assigns rounding remainder without losing a minor unit', () => {
  const result = calculateRevenueShares({
    grossRevenueMinorUnits: 1,
    communityOwnerSharePercent: 50
  });

  assert.equal(result.communityOwnerShareMinorUnits + result.crowdwideShareMinorUnits, result.netRevenueMinorUnits);
  assert.equal(result.communityOwnerShareMinorUnits, 1);
  assert.equal(result.crowdwideShareMinorUnits, 0);
});

test('share calculation requires valid amounts and an explicit valid owner percentage', () => {
  for (const input of [
    { grossRevenueMinorUnits: -1, communityOwnerSharePercent: 50 },
    { grossRevenueMinorUnits: 10, deductionsMinorUnits: 11, communityOwnerSharePercent: 50 },
    { grossRevenueMinorUnits: 10, communityOwnerSharePercent: 101 },
    { grossRevenueMinorUnits: 10, communityOwnerSharePercent: 50.001 },
    { grossRevenueMinorUnits: 10 }
  ]) {
    assert.throws(() => calculateRevenueShares(input));
  }
});

test('community ad share applies the configured percentage to campaign Waves spend', () => {
  assert.deepEqual(calculateCommunityAdShare({
    campaignSpendWaves: 1.5,
    communityOwnerSharePercent: 50
  }), {
    campaignSpendWaves: 1.5,
    communityOwnerSharePercent: 50,
    communityOwnerShareWaves: 0.75,
    crowdwideShareWaves: 0.75
  });
});

test('community ad share rounds to micro-Waves and validates its inputs', () => {
  assert.deepEqual(calculateCommunityAdShare({
    campaignSpendWaves: 0.000001,
    communityOwnerSharePercent: 50
  }), {
    campaignSpendWaves: 0.000001,
    communityOwnerSharePercent: 50,
    communityOwnerShareWaves: 0.000001,
    crowdwideShareWaves: 0
  });
  assert.throws(() => calculateCommunityAdShare({
    campaignSpendWaves: 1,
    communityOwnerSharePercent: 101
  }));
  assert.throws(() => calculateCommunityAdShare({
    campaignSpendWaves: Number.MAX_SAFE_INTEGER,
    communityOwnerSharePercent: 50
  }));
});
