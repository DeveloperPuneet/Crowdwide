// Crowdwide push notification service worker.
// Registered from public/js/push-notifications.js, only after the user
// explicitly clicks "Enable" in Settings > Notifications.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = { title: 'Crowdwide', body: 'You have a new notification.', url: '/notifications' };
  if (event.data) {
    try {
      data = { ...data, ...event.data.json() };
    } catch (error) {
      data.body = event.data.text() || data.body;
    }
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/images/Crowdwide_logo.png',
      badge: '/images/Crowdwide_logo.png',
      data: { url: data.url || '/notifications' }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/notifications';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(targetUrl) && 'focus' in client) return client.focus();
      }
      for (const client of clientList) {
        if ('focus' in client && 'navigate' in client) return client.focus().then(() => client.navigate(targetUrl));
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
