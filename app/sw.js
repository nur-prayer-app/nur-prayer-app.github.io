// Nur — Service Worker (cache-first, version stamped by build-web.js)
const CACHE_VERSION = 'nur-v228';
const CACHE_NAME = CACHE_VERSION;

const PRECACHE_URLS = [
  './',
  'index.html',
  'assets/css/styles.css',
  'assets/js/app-simplified.js',
  'assets/js/storage.js',
  'assets/js/sync.js',
  'assets/js/hijri-calendar.js',
  'assets/icons/asr.svg',
  'assets/icons/book-open.svg',
  'assets/icons/book.svg',
  'assets/icons/check.svg',
  'assets/icons/clock.svg',
  'assets/icons/dhuhr.svg',
  'assets/icons/fajr.svg',
  'assets/icons/icon-avatar.png',
  'assets/icons/icon.svg',
  'assets/icons/isha.svg',
  'assets/icons/maghrib.svg',
  'assets/icons/moon.svg',
  'assets/icons/star-crescent.svg',
  'assets/icons/sun.svg'
];

// Install — pre-cache core assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// Activate — delete old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// Skip waiting when app requests it
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

// Push — show notification from server even when app is closed
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  const title = data.title || 'Nur';
  const options = {
    body: data.body || '',
    icon: 'assets/icons/icon-avatar.png',
    badge: 'assets/icons/icon-avatar.png',
    tag: data.tag || 'nur-prayer',
    renotify: true,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Notification click — open or focus the app
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (const client of windowClients) {
        if (client.url.includes('/app/') && 'focus' in client) return client.focus();
      }
      return clients.openWindow('/app/');
    })
  );
});

// Fetch — cache-first, fall back to network, cache the response
self.addEventListener('fetch', event => {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  // Don't intercept analytics/external scripts
  if (!event.request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      return fetch(event.request).then(response => {
        // Don't cache non-ok or opaque responses from cross-origin
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }

        const responseToCache = response.clone();
        caches.open(CACHE_NAME).then(cache => {
          cache.put(event.request, responseToCache);
        });

        return response;
      });
    })
  );
});
