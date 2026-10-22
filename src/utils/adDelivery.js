// Plain-language notes for an advertiser: where is this ad showing, and if it is not
// showing somewhere, why. Pure function so it is easy to test.
const SERVING = ['active', 'approved'];

function describeDelivery(campaign, { advertiserStatus = 'approved', now = new Date() } = {}) {
  const notes = [];
  const problems = [];
  const status = campaign.status;
  if (status === 'submitted') return { problems: ['Waiting for the moderator and admin review. It starts showing as soon as it is approved.'], notes };
  if (!SERVING.includes(status)) {
    const why = { draft: 'Not submitted yet.', rejected: 'The ad was rejected.', paused: 'The ad is paused.', suspended: 'The ad was suspended by an administrator.', cancelled: 'The ad was cancelled.', completed: 'The ad has finished.' }[status];
    return { problems: why ? [why] : [], notes };
  }
  if (advertiserStatus !== 'approved') problems.push('Your advertiser profile is not approved yet, so ads are not served.');
  if (campaign.fundingStatus !== 'funded') problems.push('The budget is not funded with Waves.');
  if (Number(campaign.remainingBudget || 0) <= 0) problems.push('The budget is used up.');
  if (campaign.startDate && new Date(campaign.startDate) > now) problems.push(`Scheduled to start on ${new Date(campaign.startDate).toLocaleDateString()}.`);
  if (campaign.endDate && new Date(campaign.endDate) < now) problems.push('The end date has passed.');
  if (Number(campaign.dailyBudget || 0) > 0 && campaign.dailyBudgetDate
    && new Date(campaign.dailyBudgetDate).toDateString() === now.toDateString()
    && Number(campaign.dailyBudgetSpent || 0) >= Number(campaign.dailyBudget)) problems.push('Today\'s daily budget is used up. It resumes tomorrow.');

  const targets = (campaign.targetCommunities || []).filter((target) => target && typeof target === 'object');
  if (campaign.sitewideFallback && !targets.length) notes.push('Shown in the normal Crowdwide feed, and in monetized communities that accept ads.');
  if (campaign.smartPlacement && !targets.length) notes.push('Shown in public communities that match your topics. Quiet or off-topic communities may not carry it.');
  for (const target of targets) {
    if (target.isPrivate) problems.push(`${target.name} is private, so it cannot show ads.`);
    else if (!(target.isMonetized && target.monetizationStatus === 'approved')) problems.push(`${target.name} is not monetized (yet), so it cannot show a targeted ad.`);
    else if (!target.monetizationSettings?.adsEnabled || target.monetizationSettings?.adPlacement === 'none') problems.push(`Ads are switched off in ${target.name}. Its owner can turn them on in the community's monetization settings.`);
    else notes.push(`Shown in ${target.name}.`);
  }
  notes.push('People with an Ad-Free plan never see ads, including you if you have one.');
  return { problems, notes };
}

module.exports = { describeDelivery };
