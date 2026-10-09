const { randomInt } = require('node:crypto');
const User = require('../models/User');

const USERNAME_PATTERN = /^[a-z0-9_]{3,24}$/;
const RESERVED = new Set(['admin', 'administrator', 'moderator', 'support', 'crowdwide', 'system', 'root', 'staff', 'help']);

function normalizeUsername(value) {
  return String(value || '').trim().replace(/^@+/, '').toLowerCase();
}

function validateUsername(value) {
  const username = normalizeUsername(value);
  if (!USERNAME_PATTERN.test(username)) return { ok: false, error: 'Usernames use 3-24 letters, numbers or underscores.' };
  if (RESERVED.has(username)) return { ok: false, error: 'That username is reserved. Please pick another.' };
  return { ok: true, username };
}

function baseFrom(text) {
  const base = String(text || '').toLowerCase().replace(/[^a-z0-9_]+/g, '').slice(0, 18);
  return base.length >= 3 ? base : `${base}user`.slice(0, 18);
}

async function generateUniqueUsername(seed) {
  const base = baseFrom(seed);
  for (let i = 0; i < 12; i += 1) {
    const candidate = i === 0 ? base : `${base}${randomInt(10, 99999)}`.slice(0, 24);
    if (RESERVED.has(candidate)) continue;
    // eslint-disable-next-line no-await-in-loop
    if (!(await User.exists({ username: candidate }))) return candidate;
  }
  return `user${Date.now().toString(36)}${randomInt(100, 999)}`.slice(0, 24);
}

// Existing accounts predate usernames; give them one the first time it is needed.
async function ensureUsername(userId) {
  const user = await User.findById(userId).select('name email username');
  if (!user) return null;
  if (user.username) return user.username;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const username = await generateUniqueUsername(user.email.split('@')[0] || user.name);
    try {
      // eslint-disable-next-line no-await-in-loop
      const updated = await User.findOneAndUpdate({ _id: userId, username: { $in: [null, undefined] } }, { $set: { username } }, { new: true }).select('username');
      if (updated?.username) return updated.username;
      return (await User.findById(userId).select('username').lean())?.username || username;
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
  }
  return null;
}

module.exports = { USERNAME_PATTERN, normalizeUsername, validateUsername, generateUniqueUsername, ensureUsername };
