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
      .then(() => armReminders())
  );
});

/* ---------- Closed-tab reminders ----------
   The page writes the schedule into IndexedDB; the worker re-arms its
   timers whenever it starts. Browsers may stop the worker at any time, so
   this is best-effort — exactly like the in-page reminders, but it keeps
   firing after the tab is closed. */
const DOCS = 'docs';
const armed = {};

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(DOCS)) db.createObjectStore(DOCS, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readDoc(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DOCS, 'readonly');
      const request = tx.objectStore(DOCS).get(key);
      request.onsuccess = () => resolve(request.result ? request.result.value : null);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

function showReminder(item) {
  self.registration.showNotification('Task reminder', {
    body: item.title,
    tag: `todoist-clone-${item.id}`,
    data: { id: item.id },
  }).catch(() => {});
}

async function armReminders() {
  const items = (await readDoc('reminders')) || [];
  const now = Date.now();
  items.forEach((item) => {
    if (!item || !item.at || item.at <= now || armed[item.id]) return;
    const delay = Math.min(item.at - now, 2147483647);
    armed[item.id] = setTimeout(() => {
      delete armed[item.id];
      showReminder(item);
    }, delay);
  });
}

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'reminders') armReminders();
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const id = event.notification.data && event.notification.data.id;
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow('./todoist.html');
    })
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  // Waking the worker is a good moment to re-arm the reminder timers.
  armReminders();
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
