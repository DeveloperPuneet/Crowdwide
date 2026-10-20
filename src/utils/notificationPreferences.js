function notificationPreferenceAllows(preferences, key, type) {
  if (preferences?.[key] === false) return false;
  if (key === 'comments' && preferences?.mentionsOnly === true && !['mention', 'post_reply'].includes(type)) return false;
  return true;
}

module.exports = { notificationPreferenceAllows };
