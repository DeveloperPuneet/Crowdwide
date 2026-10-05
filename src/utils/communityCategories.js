const COMMUNITY_CATEGORIES = [
  { value: 'general', label: 'General' },
  { value: 'community', label: 'Community' },
  { value: 'technology', label: 'Technology' },
  { value: 'social networking', label: 'Social Networking' },
  { value: 'chatting', label: 'Chatting' },
  { value: 'arts & crafts', label: 'Arts & Crafts' },
  { value: 'education', label: 'Education' },
  { value: 'gaming', label: 'Gaming' },
  { value: 'health & wellness', label: 'Health & Wellness' },
  { value: 'lifestyle', label: 'Lifestyle' },
  { value: 'music', label: 'Music' },
  { value: 'science', label: 'Science' },
  { value: 'sports', label: 'Sports' },
  { value: 'travel', label: 'Travel' },
  { value: 'other', label: 'Other' }
];

function normalizeCommunityCategory(value, currentValue) {
  const normalized = String(value || '').trim().toLowerCase();
  if (COMMUNITY_CATEGORIES.some((category) => category.value === normalized)) return normalized;
  if (currentValue && normalized === String(currentValue).trim().toLowerCase()) return normalized;
  return null;
}

module.exports = { COMMUNITY_CATEGORIES, normalizeCommunityCategory };
