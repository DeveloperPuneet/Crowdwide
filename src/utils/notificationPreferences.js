function notificationPreferenceAllows(preferences, key, type) {
  if (preferences?.[key] === false) return false;
  if (key === 'comments' && preferences?.mentionsOnly === true && type !== 'mention') return false;
  return true;
}

module.exports = { notificationPreferenceAllows };
