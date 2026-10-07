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

module.exports = { calculateRevenueShares };
