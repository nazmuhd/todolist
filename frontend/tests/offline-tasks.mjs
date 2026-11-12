/* Offline task test: go offline, create a task, reload offline, and confirm
 * it survived. Run with `pnpm test:offline`. */
import { createHarness, sleep } from './harness.mjs';

const h = await createHarness({ port: 5197, debugPort: 9333 });
const { send, evalJs, waitFor, check, errors } = h;

try {
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Page.enable');
  await waitFor('window.__appReady === true', 'app ready (online)');
  await waitFor(`navigator.serviceWorker.ready.then(r => !!r.active)`, 'service worker active');

  await send('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
  });
  await send('Page.reload', { ignoreCache: false });
  await sleep(400);
  await waitFor('window.__appReady === true', 'app ready (offline)', 15000);
  check('boots offline', true);

  // Create a task while offline.
  await evalJs(`document.getElementById('quick-add-placeholder').click()`);
  await waitFor(`!document.getElementById('quick-add-editor').classList.contains('hidden')`, 'quick add open');
  await evalJs(`(() => {
    const t = document.getElementById('quick-add-input');
    t.value = 'Offline task';
    t.dispatchEvent(new Event('input', {bubbles:true}));
    document.getElementById('quick-add-submit').click();
  })()`);
  await waitFor(`document.getElementById('task-list').textContent.includes('Offline task')`, 'task created offline');
  check('creates a task offline', true);

  // Edit it offline.
  await evalJs(`(() => {
    const row = [...document.querySelectorAll('#task-list li[data-task-id]')].find(x => x.textContent.includes('Offline task'));
    if (row) { const c = row.querySelector('.task-check, .task-checkbox, input[type=checkbox]'); if (c) c.click(); }
  })()`);
  await sleep(400);
  check('completes a task offline', await evalJs(`(() => {
    document.querySelector('[data-view="completed"]').click();
    return true;
  })()`));
  await sleep(300);
  check('the task moved to Completed', await evalJs(`document.getElementById('task-list').textContent.includes('Offline task')`));
  await evalJs(`document.querySelector('[data-view="inbox"]').click()`);
  await sleep(200);

  // Reload offline: the data must come back from IndexedDB.
  await sleep(600);
  await send('Page.reload', { ignoreCache: false });
  await sleep(500);
  await waitFor('window.__appReady === true', 'app ready after offline reload', 15000);
  await sleep(300);
  // Look in the Completed view: a completed task leaves the Inbox list.
  await evalJs(`document.querySelector('[data-view="completed"]').click()`);
  await sleep(300);
  check('the offline task survives an offline reload', await evalJs(`document.getElementById('task-list').textContent.includes('Offline task')`));

  // Back online: the task should reach the server.
  await send('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });
  await evalJs(`window.dispatchEvent(new Event('online'))`);
  await sleep(2000);

  // Ask the harness API directly whether the offline task made it across.
  let synced = false;
  for (let i = 0; i < 20 && !synced; i += 1) {
    const res = await fetch(`http://127.0.0.1:5197/api/sync?since=0&limit=500`);
    const body = await res.json();
    synced = (body.changes?.tasks || []).some(t => t.data && t.data.title === 'Offline task');
    if (!synced) await sleep(300);
  }
  check('the offline task syncs to the server once back online', synced);

  const realErrors = errors.filter((e) => !/\/api\//.test(e) && !/ERR_INTERNET_DISCONNECTED/.test(e) && !/Failed to fetch/.test(e));
  check('no console errors', realErrors.length === 0, realErrors.join(' | '));
} catch (err) {
  check('offline task run', false, err.message);
  console.error(err);
} finally {
  const code = h.finish();
  await h.close();
  process.exit(code);
}
