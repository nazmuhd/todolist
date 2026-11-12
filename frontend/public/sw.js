/* Offline support for the Todoist clone.
   Everything the app needs is served from this origin (the libraries are
   vendored locally), so the first visit is enough to work offline. */
const CACHE = 'todoist-clone-v6';
const DB_NAME = 'todoist-clone-files';
const DB_VERSION = 2;
const STORE = 'files';
const DOCS = 'docs';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
];

/* Cache every same-origin script, stylesheet and icon the shell references
   (the hashed bundle and the vendored libraries). The install runs after the
   first page load, so without this those files would only be cached on the
   second visit. */
async function precachePageAssets(cache) {
  try {
    const response = await fetch('./index.html', { cache: 'reload' });
    if (!response.ok) return;
    const html = await response.text();
    const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map(m => m[1])
      .filter(u => u && !u.startsWith('#') && !u.startsWith('//') && !/^[a-z]+:/i.test(u))
      .filter((u, i, all) => all.indexOf(u) === i);
    await Promise.all(urls.map(u => cache.add(u).catch(() => {})));
  } catch {
    /* Offline precache is best-effort; fetch falls back to the cache. */
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then(async (cache) => {
        await cache.addAll(SHELL).catch(() => {});
        await precachePageAssets(cache);
      })
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

/* Reminder notifications give the user Complete and Snooze without opening
   the app first. The Snooze action uses the app's 1-hour preset. */
const NOTIFICATION_ACTIONS = [
  { action: 'complete', title: 'Complete' },
  { action: 'snooze-60', title: 'Snooze 1h' },
];

function showReminder(item) {
  self.registration.showNotification('Task reminder', {
    body: item.title,
    tag: `todoist-clone-${item.id}`,
    actions: NOTIFICATION_ACTIONS,
    data: { id: item.taskId || item.id, taskId: item.taskId || '' },
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

/* ---------- Web Push ----------
   The server schedules reminders and sends the payload; the worker shows it
   even when no tab is open. */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* not JSON */ }
  const title = data.title || 'Task reminder';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    tag: data.tag || 'todoist-clone',
    actions: NOTIFICATION_ACTIONS,
    data: { id: data.taskId || data.id || '', taskId: data.taskId || '' },
  }).catch(() => {}));
});

/** Focuses a tab and forwards the action; opens the app when none is open. */
async function deliverAction(action, taskId) {
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (list.length) {
    list.forEach((client) => client.postMessage({ type: 'notification-action', action, taskId }));
    const focused = list.find((client) => 'focus' in client) || list[0];
    if (focused && 'focus' in focused) await focused.focus();
    return;
  }
  const query = `action=${encodeURIComponent(action)}&task=${encodeURIComponent(taskId || '')}`;
  await self.clients.openWindow(`./index.html#/action?${query}`);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const taskId = data.taskId || data.id || '';

  // A notification button was pressed.
  if (event.action) {
    event.waitUntil(deliverAction(event.action, taskId));
    return;
  }

  // The body was clicked: focus an existing tab, or deep-link to the task.
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of list) {
      if ('focus' in client) {
        await client.focus();
        return;
      }
    }
    const hash = taskId ? `#/task/${encodeURIComponent(taskId)}` : './index.html';
    await self.clients.openWindow(taskId ? `./index.html${hash}` : hash);
  })());
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
      fetch(request).catch(() => caches.match('./index.html').then(r => r || caches.match('./')))
    );
    return;
  }

  // Everything else: network first, so a new build is picked up at once,
  // with the cache as the offline fallback.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then(cached => cached || Response.error()))
  );
});
