// Topics offered in first-time onboarding. Picking one adds its hashtag to the
// member's profile hashtags, which the feed and "people to follow" already use.
// `categories` links a topic to community categories so matching communities
// can be suggested even when they have no hashtags yet.
const ONBOARDING_INTERESTS = [
  { value: 'technology', label: 'Technology', categories: ['technology'] },
  { value: 'coding', label: 'Coding', categories: ['technology'] },
  { value: 'gaming', label: 'Gaming', categories: ['gaming'] },
  { value: 'music', label: 'Music', categories: ['music'] },
  { value: 'art', label: 'Art & design', categories: ['arts & crafts'] },
  { value: 'photography', label: 'Photography', categories: ['arts & crafts'] },
  { value: 'writing', label: 'Writing & books', categories: ['education'] },
  { value: 'science', label: 'Science', categories: ['science'] },
  { value: 'education', label: 'Learning', categories: ['education'] },
  { value: 'travel', label: 'Travel', categories: ['travel'] },
  { value: 'sports', label: 'Sports', categories: ['sports'] },
  { value: 'fitness', label: 'Fitness & health', categories: ['health & wellness', 'sports'] },
  { value: 'lifestyle', label: 'Lifestyle', categories: ['lifestyle'] },
  { value: 'food', label: 'Food & cooking', categories: ['lifestyle'] },
  { value: 'business', label: 'Business & startups', categories: ['technology', 'education'] },
  { value: 'movies', label: 'Movies & shows', categories: ['chatting'] }
];

const INTEREST_VALUES = new Set(ONBOARDING_INTERESTS.map((interest) => interest.value));

function categoriesForInterests(values = []) {
  const wanted = new Set(values);
  return Array.from(new Set(ONBOARDING_INTERESTS.filter((interest) => wanted.has(interest.value)).flatMap((interest) => interest.categories)));
}

module.exports = { ONBOARDING_INTERESTS, INTEREST_VALUES, categoriesForInterests };
