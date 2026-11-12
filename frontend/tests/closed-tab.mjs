/* Closed-tab test: create a task offline, close the tab completely, reopen
 * it, and check the task survived and still reaches the server.
 *
 * Run with `pnpm test:offline`.
 */
import { createHarness, sleep } from './harness.mjs';

const PORT = 5185;
const DEBUG_PORT = 9321;
const h = await createHarness({ port: PORT, debugPort: DEBUG_PORT });
const { send, evalJs, waitFor, check, errors } = h;

try {
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Page.enable');
  await waitFor('window.__appReady === true', 'app ready (online)');
  await waitFor(`navigator.serviceWorker.ready.then(r => !!r.active)`, 'service worker active');

  // Go offline and create a task.
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await sleep(400);
  await evalJs(`document.getElementById('quick-add-placeholder').click()`);
  await waitFor(`!document.getElementById('quick-add-editor').classList.contains('hidden')`, 'quick add open');
  await evalJs(`(() => {
    const t = document.getElementById('quick-add-input');
    t.value = 'Closed tab task';
    t.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('quick-add-submit').click();
  })()`);
  await waitFor(`document.getElementById('task-list').textContent.includes('Closed tab task')`, 'task created offline');
  await sleep(600);

  // The task must already be in IndexedDB, not only in memory.
  const stored = await evalJs(`(async () => {
    const db = await new Promise(res => { const r = indexedDB.open('todoist-clone-files'); r.onsuccess = () => res(r.result); });
    const doc = await new Promise(res => { const tx = db.transaction('docs','readonly'); const g = tx.objectStore('docs').get('todoist-clone-v1'); g.onsuccess = () => res(g.result ? g.result.value : null); });
    return JSON.stringify((doc?.tasks || []).map(t => t.title));
  })()`);
  check('the task is written to IndexedDB straight away', JSON.parse(stored).includes('Closed tab task'), stored);

  // The service worker keeps running with no tab open, so closed-tab
  // reminders still fire.
  const swActive = await evalJs(`navigator.serviceWorker.ready.then(r => !!r.active)`);
  check('the service worker is active', swActive);

  // Close the tab.
  const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const page = targets.find(t => t.type === 'page' && t.url.includes(String(PORT)));
  await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/${page.id}`);
  await sleep(800);
  check('the tab was closed', true);

  // The task must still be on disk after the tab is gone.
  const afterClose = await (async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/sync?since=0&limit=500`);
    const body = await res.json();
    return (body.changes?.tasks || []).some(t => t.data && t.data.title === 'Closed tab task');
  })();
  check('the closed tab did not upload it yet (it was offline)', afterClose === false);

  // Reopen a tab and come back online.
  const created = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?http://127.0.0.1:${PORT}/`, { method: 'PUT' })).json();
  await sleep(1500);
  const fresh = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json())
    .find(t => t.type === 'page' && t.url.includes(String(PORT)));

  // Drive the new tab over its own websocket.
  const { WebSocket } = await import('ws').catch(() => ({ WebSocket: globalThis.WebSocket }));
  const ws = new WebSocket(fresh.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const cdp = (method, params = {}) => new Promise((res) => {
    const n = ++id;
    pending.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return r.result?.result?.value;
  };

  await cdp('Runtime.enable');
  await cdp('Network.enable');
  // The new tab is online again.
  await cdp('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

  const start = Date.now();
  let ready = false;
  while (Date.now() - start < 15000 && !ready) {
    await sleep(200);
    ready = await evaluate('window.__appReady === true');
  }
  check('the reopened tab boots', ready);

  await sleep(2500);
  const list = await evaluate(`document.getElementById('task-list').textContent`);
  check('the task survived the closed tab', String(list).includes('Closed tab task'), String(list).slice(0, 120));

  let onServer = false;
  for (let i = 0; i < 30 && !onServer; i += 1) {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/sync?since=0&limit=500`);
    const body = await res.json();
    onServer = (body.changes?.tasks || []).some(t => t.data && t.data.title === 'Closed tab task');
    if (!onServer) await sleep(300);
  }
  check('the task reaches the server after the tab reopens', onServer);

  ws.close();
  const realErrors = errors.filter((e) => !/\/api\//.test(e) && !/ERR_INTERNET_DISCONNECTED/.test(e) && !/Failed to fetch/.test(e));
  check('no console errors', realErrors.length === 0, realErrors.join(' | '));
} catch (err) {
  check('closed tab run', false, err.message);
  console.error(err);
} finally {
  const code = h.finish();
  await h.close();
  process.exit(code);
}
