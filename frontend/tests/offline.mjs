/* Offline test: load the built app once, drop the network, reload, and check
 * that the shell, styles, vendor libraries and icons still come up.
 * Run with `pnpm test:offline` (builds first). */
import { createHarness, sleep } from './harness.mjs';

const h = await createHarness({ port: 5198, debugPort: 9334 });
const { send, evalJs, waitFor, check, errors } = h;

try {
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await waitFor('window.__appReady === true', 'app ready (online)');
  check('boots online', true);

  // The first visit must be enough: the worker precaches the built bundle and
  // the vendored scripts during install.
  await waitFor(`navigator.serviceWorker.ready.then(r => !!r.active)`, 'service worker active');
  const assets = await evalJs(`performance.getEntriesByType('resource').map(e => new URL(e.name).pathname).filter(p => p.startsWith('/assets/'))`);
  await waitFor(`(async () => {
    const cached = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const req of await cache.keys()) cached.push(new URL(req.url).pathname);
    }
    return ${JSON.stringify(assets)}.every(a => cached.includes(a));
  })()`, 'built assets cached', 10000);
  check('first visit caches the bundle', true, `${assets.length} assets`);

  // Go offline and reload: the navigation and every module must come from the cache.
  await send('Network.emulateNetworkConditions', {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  await send('Page.reload', { ignoreCache: false });
  await sleep(300);
  await waitFor('window.__appReady === true', 'app ready (offline)', 15000);
  check('boots offline', true);

  const state = await evalJs(`JSON.stringify({
    title: document.getElementById('view-title-text')?.textContent,
    projects: !!document.getElementById('projects-list'),
    quickAdd: !!document.getElementById('quick-add-bar'),
    sheets: document.styleSheets.length,
  })`);
  const s = JSON.parse(state);
  check('shell rendered offline', s.title === 'Inbox' && s.projects && s.quickAdd, state);
  check('stylesheets loaded offline', s.sheets > 0, String(s.sheets));

  const libs = await evalJs(`JSON.stringify({
    sortable: typeof Sortable,
    lucide: typeof lucide,
    chrono: typeof chrono,
    flatpickr: typeof flatpickr,
    rrule: typeof window.rrule,
    icons: document.querySelectorAll('svg.lucide').length,
  })`);
  const l = JSON.parse(libs);
  check('vendor libraries loaded offline',
    l.sortable === 'function' && l.lucide === 'object' && l.chrono === 'object'
      && l.flatpickr === 'function' && l.rrule === 'object', libs);
  check('icons rendered offline', l.icons > 5, String(l.icons));
  check('no console errors', errors.length === 0, errors.join(' | '));
} catch (err) {
  check('offline run', false, err.message);
  console.error(err);
} finally {
  const code = h.finish();
  await h.close();
  process.exit(code);
}
