// Crowdwide service worker.
//  - Makes the site installable (PWA) and shows a friendly page when offline.
//  - Speeds up repeat visits by caching static assets (CSS, JS, images).
//  - Delivers web push notifications (opt-in, enabled from Settings).
//
// It deliberately NEVER caches pages, API responses, uploaded media or
// anything that needs a login: feeds, messages and wallets are personal and
// must always come from the network. Only the offline fallback page is
// stored for navigations.

const CACHE_VERSION = 'v2';
const STATIC_CACHE = `crowdwide-static-${CACHE_VERSION}`;
const OFFLINE_URL = '/offline.html';
const PRECACHE_URLS = [
  OFFLINE_URL,
  '/images/Crowdwide_logo_192.png',
  '/images/Crowdwide_logo_512.png'
];
const STATIC_PREFIXES = ['/css/', '/js/', '/images/', '/vendor/'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .catch(() => {}) // never block installation (and push) on a cache hiccup
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith('crowdwide-') && key !== STATIC_CACHE)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function isStaticAsset(url) {
  return url.origin === self.location.origin
    && STATIC_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Page navigations: always the network; offline page only if it fails.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match(OFFLINE_URL).then((cached) => cached || Response.error()))
    );
    return;
  }

  // Static assets: serve the cached copy immediately and refresh it in the
  // background (stale-while-revalidate), so deploys show up on the next visit.
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const refresh = fetch(request).then((response) => {
          if (response && response.ok && response.type === 'basic') cache.put(request, response.clone());
          return response;
        }).catch(() => null);
        return cached || (await refresh) || Response.error();
      })
    );
  }
  // Everything else (API, media, polling, auth) goes straight to the network.
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
      icon: '/images/Crowdwide_logo_192.png',
      badge: '/images/Crowdwide_logo_192.png',
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
