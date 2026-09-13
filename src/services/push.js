const webPush = require('web-push');
const User = require('../models/User');

let configured = false;

function ensureConfigured() {
  if (configured) return true;
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return false;
  webPush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:hello@crowdwide.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  configured = true;
  return true;
}

function isPushConfigured() {
  return ensureConfigured();
}

function getPublicKey() {
  return ensureConfigured() ? process.env.VAPID_PUBLIC_KEY : null;
}

// Sends `payload` (plain object -- title/body/url are read by the service
// worker's push handler, see public/sw.js) to every device the user has
// subscribed from. Subscriptions the push service reports as gone
// (404/410, e.g. the user uninstalled the browser or cleared site data)
// are pruned from the user's record automatically.
async function sendPushToUser(userId, payload) {
  if (!ensureConfigured()) return;
  const user = await User.findById(userId).select('pushNotificationsEnabled pushSubscriptions');
  if (!user?.pushNotificationsEnabled || !user.pushSubscriptions?.length) return;

  const body = JSON.stringify(payload);
  const deadEndpoints = [];
  await Promise.all(user.pushSubscriptions.map(async (subscription) => {
    try {
      await webPush.sendNotification({
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth }
      }, body);
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) deadEndpoints.push(subscription.endpoint);
      else console.error('Push notification failed:', error.message);
    }
  }));

  if (deadEndpoints.length) {
    await User.findByIdAndUpdate(userId, { $pull: { pushSubscriptions: { endpoint: { $in: deadEndpoints } } } });
  }
}

module.exports = { isPushConfigured, getPublicKey, sendPushToUser };
