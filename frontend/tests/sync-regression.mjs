/* Sync regression test: local work must survive a first sync that finds a
 * populated server.
 *
 * The bug this guards against: when the sync metadata is missing (the first
 * sync never finished, or the browser booted offline), the client treated
 * itself as a fresh device and replaced its state with the server's. Any
 * task created offline was then gone from the browser AND never uploaded.
 *
 * Run with `pnpm test:offline`.
 */
import { createHarness, sleep } from './harness.mjs';

const PORT = 5186;
const h = await createHarness({ port: PORT, debugPort: 9322 });
const { send, evalJs, waitFor, check, errors } = h;

async function serverTasks() {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/sync?since=0&limit=500`);
  const body = await res.json();
  return (body.changes?.tasks || []).map(t => t.data?.title).filter(Boolean);
}

try {
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Page.enable');
  await waitFor('window.__appReady === true', 'app ready');
  await sleep(1200);

  // The server already holds a task, as it would after another device synced.
  await fetch(`http://127.0.0.1:${PORT}/api/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      changes: {
        tasks: [{
          id: 'srv_1', baseRev: 0,
          data: { id: 'srv_1', title: 'Server task', completed: false, projectId: null, labels: [], priority: 4, reminders: [] },
        }],
      },
    }),
  });

  await send('Page.reload');
  await sleep(1800);
  await waitFor('window.__appReady === true', 'app ready after reload');
  await sleep(1500);
  check('the app adopts the server task', (await evalJs(`document.getElementById('task-list').textContent`)).includes('Server task'));

  // A task created on this device, never pushed.
  await evalJs(`document.getElementById('quick-add-placeholder').click()`);
  await waitFor(`!document.getElementById('quick-add-editor').classList.contains('hidden')`, 'quick add open');
  await evalJs(`(() => {
    const t = document.getElementById('quick-add-input');
    t.value = 'Unsynced local task';
    t.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('quick-add-submit').click();
  })()`);
  await waitFor(`document.getElementById('task-list').textContent.includes('Unsynced local task')`, 'task created');

  // Drop the sync metadata, so the next sync has no snapshot to compare with
  // and has to work out what is local by itself.
  await evalJs(`(async () => {
    const db = await new Promise(res => { const r = indexedDB.open('todoist-clone-files'); r.onsuccess = () => res(r.result); });
    await new Promise(res => { const tx = db.transaction('docs', 'readwrite'); tx.objectStore('docs').delete('todoist-clone-sync-meta'); tx.oncomplete = res; });
    return true;
  })()`);

  await send('Page.reload');
  await sleep(2500);
  await waitFor('window.__appReady === true', 'app ready after the metadata is dropped');
  await sleep(2500);

  const local = await evalJs(`document.getElementById('task-list').textContent`);
  check('the unsynced local task survives the sync', local.includes('Unsynced local task'));
  check('the server task is still there too', local.includes('Server task'));

  let onServer = false;
  for (let i = 0; i < 25 && !onServer; i += 1) {
    onServer = (await serverTasks()).includes('Unsynced local task');
    if (!onServer) await sleep(300);
  }
  check('the unsynced task is uploaded to the server', onServer);

  // The server's own records must survive: a client that has never seen a
  // record may not delete it.
  check('the server task was not deleted by the client', (await serverTasks()).includes('Server task'));

  const realErrors = errors.filter((e) => !/\/api\//.test(e) && !/ERR_INTERNET_DISCONNECTED/.test(e) && !/Failed to fetch/.test(e));
  check('no console errors', realErrors.length === 0, realErrors.join(' | '));
} catch (err) {
  check('sync regression run', false, err.message);
  console.error(err);
} finally {
  const code = h.finish();
  await h.close();
  process.exit(code);
}
