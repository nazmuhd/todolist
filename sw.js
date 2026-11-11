/* Offline support for the Todoist clone.
   Everything the app needs is served from this origin (the libraries are
   vendored locally), so the first visit is enough to work offline. */
const CACHE = 'todoist-clone-v2';
const SHELL = [
  './',
  './todoist.html',
  './app.js',
  './storage.js',
  './styles.css',
  './manifest.webmanifest',
  './icon.svg',
  './vendor/tailwind.js',
  './vendor/lucide.min.js',
  './vendor/chrono.bundle.js',
  './vendor/flatpickr.min.js',
  './vendor/flatpickr.min.css',
  './vendor/rrule.min.js',
  './vendor/sortable.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Navigations: serve the app shell when the network is unavailable.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('./todoist.html').then(r => r || caches.match('./')))
    );
    return;
  }

  // Everything else: cache first, then refresh the cache in the background.
  event.respondWith(
    caches.match(request).then(cached => {
      const network = fetch(request).then(response => {
        if (response && response.status === 200 && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy));
        }
        return response;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
