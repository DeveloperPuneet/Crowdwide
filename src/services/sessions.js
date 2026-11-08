// Signing a device out for real. Deleting the LoginSession row is not enough on
// its own - requireAuth recreates it for any session that is still alive in the
// store - so the stored session itself is destroyed too.
const LoginSession = require('../models/LoginSession');
const logger = require('./logger');

const destroyInStore = (store, sessionId) => new Promise((resolve) => {
  if (!store || typeof store.destroy !== 'function') return resolve();
  try { store.destroy(sessionId, () => resolve()); } catch (error) { logger.warn('Could not destroy a stored session', error); resolve(); }
});

// Signs out every device of `userId` (except the current one when `keepCurrent`).
async function revokeSessions(req, userId, { keepCurrent = true, only = null } = {}) {
  const filter = { user: userId };
  if (only) filter._id = only;
  if (keepCurrent && req.sessionID) filter.sessionId = { $ne: req.sessionID };
  const rows = await LoginSession.find(filter).select('sessionId').lean();
  const store = req.sessionStore || req.app?.locals?.sessionStore;
  await Promise.all(rows.map((row) => destroyInStore(store, row.sessionId)));
  await LoginSession.deleteMany({ _id: { $in: rows.map((row) => row._id) } });
  return rows.length;
}

module.exports = { revokeSessions };
