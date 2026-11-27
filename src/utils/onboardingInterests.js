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
const ADJACENT_INTERESTS = {
  technology: ['coding', 'science', 'business', 'gaming'],
  coding: ['technology', 'science', 'business'],
  gaming: ['technology', 'art', 'sports', 'movies'],
  music: ['art', 'gaming', 'movies'],
  art: ['photography', 'music', 'writing', 'movies'],
  photography: ['art', 'travel'],
  writing: ['education', 'science', 'movies'],
  science: ['technology', 'coding', 'education'],
  education: ['writing', 'science', 'business'],
  travel: ['photography', 'food', 'sports'],
  sports: ['fitness', 'gaming', 'food'],
  fitness: ['sports', 'lifestyle', 'food'],
  lifestyle: ['food', 'travel', 'fitness'],
  food: ['lifestyle', 'travel'],
  business: ['technology', 'coding', 'education'],
  movies: ['writing', 'art', 'gaming', 'music']
};
const RELATED_TOPIC_ALIASES = {
  coding: [
    'ai', 'artificial_intelligence', 'artificial-intelligence',
    'machine_learning', 'machine-learning', 'machinelearning',
    'programming', 'web_development', 'web-development', 'webdev',
    'open_source', 'open-source', 'opensource'
  ]
};

function categoriesForInterests(values = []) {
  const wanted = new Set(values);
  return Array.from(new Set(ONBOARDING_INTERESTS.filter((interest) => wanted.has(interest.value)).flatMap((interest) => interest.categories)));
}

function relatedInterestsFor(values = []) {
  const wanted = new Set(values.map((value) => String(value).toLowerCase()));
  const categories = new Set(categoriesForInterests(Array.from(wanted)));
  const related = ONBOARDING_INTERESTS
    .filter((interest) => !wanted.has(interest.value) && interest.categories.some((category) => categories.has(category)))
    .map((interest) => interest.value);
  return new Set([...related, ...Array.from(wanted).flatMap((value) => RELATED_TOPIC_ALIASES[value] || [])]
    .filter((value) => !wanted.has(value)));
}

function adjacentInterestsFor(values = []) {
  const wanted = new Set(values.map((value) => String(value).toLowerCase()));
  return new Set(Array.from(wanted).flatMap((value) => ADJACENT_INTERESTS[value] || []).filter((value) => !wanted.has(value)));
}

module.exports = {
  ONBOARDING_INTERESTS,
  INTEREST_VALUES,
  ADJACENT_INTERESTS,
  RELATED_TOPIC_ALIASES,
  categoriesForInterests,
  relatedInterestsFor,
  adjacentInterestsFor
};
