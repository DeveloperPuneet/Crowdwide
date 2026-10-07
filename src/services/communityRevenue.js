function requireMinorUnits(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

function calculateRevenueShares({
  grossRevenueMinorUnits,
  deductionsMinorUnits = 0,
  communityOwnerSharePercent
}) {
  const gross = requireMinorUnits(grossRevenueMinorUnits, 'grossRevenueMinorUnits');
  const deductions = requireMinorUnits(deductionsMinorUnits, 'deductionsMinorUnits');
  if (deductions > gross) {
    throw new RangeError('deductionsMinorUnits cannot exceed grossRevenueMinorUnits.');
  }

  if (!Number.isFinite(communityOwnerSharePercent)
    || communityOwnerSharePercent < 0
    || communityOwnerSharePercent > 100) {
    throw new RangeError('communityOwnerSharePercent must be between 0 and 100.');
  }

  const percentageBasisPoints = Math.round(communityOwnerSharePercent * 100);
  if (Math.abs(communityOwnerSharePercent * 100 - percentageBasisPoints) > 1e-8) {
    throw new RangeError('communityOwnerSharePercent cannot have more than two decimal places.');
  }

  const netRevenueMinorUnits = gross - deductions;
  const communityOwnerShareMinorUnits = Number(
    (BigInt(netRevenueMinorUnits) * BigInt(percentageBasisPoints) + 5000n) / 10000n
  );
  const crowdwideShareMinorUnits = netRevenueMinorUnits - communityOwnerShareMinorUnits;

  return {
    grossRevenueMinorUnits: gross,
    deductionsMinorUnits: deductions,
    netRevenueMinorUnits,
    communityOwnerSharePercent,
    communityOwnerShareMinorUnits,
    crowdwideSharePercent: 100 - communityOwnerSharePercent,
    crowdwideShareMinorUnits
  };
}

function calculateCommunityAdShare({ campaignSpendWaves, communityOwnerSharePercent }) {
  if (!Number.isFinite(campaignSpendWaves) || campaignSpendWaves < 0) {
    throw new TypeError('campaignSpendWaves must be a non-negative number.');
  }
  const spendMicroWaves = Math.round(campaignSpendWaves * 1_000_000);
  if (!Number.isSafeInteger(spendMicroWaves)) {
    throw new RangeError('campaignSpendWaves exceeds the supported precision.');
  }
  const shares = calculateRevenueShares({
    grossRevenueMinorUnits: spendMicroWaves,
    communityOwnerSharePercent
  });
  return {
    campaignSpendWaves: spendMicroWaves / 1_000_000,
    communityOwnerSharePercent: shares.communityOwnerSharePercent,
    communityOwnerShareWaves: shares.communityOwnerShareMinorUnits / 1_000_000,
    crowdwideShareWaves: shares.crowdwideShareMinorUnits / 1_000_000
  };
}

module.exports = { calculateRevenueShares, calculateCommunityAdShare };
