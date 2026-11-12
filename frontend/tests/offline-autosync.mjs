/* Automatic sync test: go offline, create a task, restore the network
 * WITHOUT dispatching an 'online' event, and see if it syncs by itself.
 * Run with `pnpm test:offline`. */
import { createHarness, sleep } from './harness.mjs';

const h = await createHarness({ port: 5196, debugPort: 9332 });
const { send, evalJs, waitFor, check, errors } = h;

try {
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Page.enable');
  await waitFor('window.__appReady === true', 'app ready (online)');

  // Record the online/offline transitions the browser reports on its own.
  await evalJs(`(() => {
    window.__netEvents = [];
    window.addEventListener('online', () => window.__netEvents.push('online'));
    window.addEventListener('offline', () => window.__netEvents.push('offline'));
  })()`);

  await send('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
  });
  await sleep(300);
  check('the browser reports going offline', await evalJs(`window.__netEvents.includes('offline')`));

  await evalJs(`document.getElementById('quick-add-placeholder').click()`);
  await waitFor(`!document.getElementById('quick-add-editor').classList.contains('hidden')`, 'quick add open');
  await evalJs(`(() => {
    const t = document.getElementById('quick-add-input');
    t.value = 'Auto sync task';
    t.dispatchEvent(new Event('input', {bubbles:true}));
    document.getElementById('quick-add-submit').click();
  })()`);
  await waitFor(`document.getElementById('task-list').textContent.includes('Auto sync task')`, 'task created offline');

  // Restore the network. No manual 'online' dispatch: the browser must fire it.
  await send('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });

  let synced = false;
  for (let i = 0; i < 30 && !synced; i += 1) {
    const res = await fetch(`http://127.0.0.1:5196/api/sync?since=0&limit=500`);
    const body = await res.json();
    synced = (body.changes?.tasks || []).some(t => t.data && t.data.title === 'Auto sync task');
    if (!synced) await sleep(300);
  }
  check('it syncs automatically when the network returns', synced);
  check('the browser fired the online event itself', await evalJs(`window.__netEvents.includes('online')`));

  const realErrors = errors.filter((e) => !/\/api\//.test(e) && !/ERR_INTERNET_DISCONNECTED/.test(e) && !/Failed to fetch/.test(e));
  check('no console errors', realErrors.length === 0, realErrors.join(' | '));
} catch (err) {
  check('auto sync run', false, err.message);
  console.error(err);
} finally {
  const code = h.finish();
  await h.close();
  process.exit(code);
}
