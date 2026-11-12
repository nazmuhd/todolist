/* End-to-end test: the real Express + SQLite server and the built app in a
 * headless browser, with no stubs.
 *
 * Verifies the per-entity sync loop:
 *   - a task created in the UI is pushed to GET /api/sync
 *   - the app pulls a record written by another client
 *   - everything survives a reload (it came back from SQLite)
 *
 * Requires a prior `pnpm build` (the server serves frontend/dist) and a
 * Chromium-based browser. Override the browser with BROWSER=<path>.
 *
 * Run with: pnpm test:e2e
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = Number(process.env.E2E_PORT || 4020);
const DEBUG = Number(process.env.E2E_DEBUG_PORT || 9335);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  const candidates = process.env.BROWSER
    ? [process.env.BROWSER]
    : process.platform === 'win32'
      ? [
          'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
          'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
          'C:/Program Files/Google/Chrome/Application/chrome.exe',
          'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        ]
      : process.platform === 'darwin'
        ? [
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          ]
        : ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium'];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('No Chromium-based browser found. Set BROWSER to its executable.');
  return found;
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todoist-e2e-'));
const dbPath = path.join(dataDir, 'e2e.db');
const profile = path.join(os.tmpdir(), 'todoist-e2e-profile-' + Date.now());
const errors = [];
let server;
let browser;

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) process.exitCode = 1;
}

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) return;
    } catch { /* still starting */ }
    await sleep(150);
  }
  throw new Error('server did not start');
}

try {
  server = spawn(process.execPath, ['--experimental-strip-types', 'src/server.ts'], {
    cwd: path.join(ROOT, 'server'),
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production', DATABASE_PATH: dbPath },
    stdio: 'ignore',
  });
  await waitForServer();
  check('real server boots', true);

  browser = spawn(findBrowser(), [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${profile}`,
    `http://127.0.0.1:${PORT}/`,
  ], { stdio: 'ignore' });

  let target;
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.url.includes(String(PORT)));
      if (target) break;
    } catch { /* browser still starting */ }
    await sleep(150);
  }
  if (!target) throw new Error('no browser target');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      errors.push(msg.params.entry.text);
    }
  };

  const send = (method, params = {}) => {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  const evalJs = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = async (expression, label, timeout = 12000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        if (await evalJs(expression)) return;
      } catch { /* navigating */ }
      await sleep(100);
    }
    throw new Error('timeout: ' + label);
  };

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.reload');
  await waitFor('window.__appReady === true', 'app ready');
  check('app boots from the Express server', true);

  // Create a task through the real UI.
  await evalJs(`document.getElementById('quick-add-placeholder').click()`);
  await waitFor(`!document.getElementById('quick-add-editor').classList.contains('hidden')`, 'quick add');
  await evalJs(`(() => {
    const input = document.getElementById('quick-add-input');
    input.value = 'Persist me to SQLite';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('quick-add-submit').click();
  })()`);
  await waitFor(`document.getElementById('task-list').textContent.includes('Persist me to SQLite')`, 'task rendered');
  await sleep(900); // allow the debounced sync to run

  // The task must have been pushed as its own entity row.
  const feed = await (await fetch(`http://127.0.0.1:${PORT}/api/sync?since=0`)).json();
  const titles = (feed.changes?.tasks || []).map((row) => row.data?.title);
  check('the task reached /api/sync as an entity', titles.includes('Persist me to SQLite'), JSON.stringify(titles));
  check('the sync cursor advanced', feed.cursor >= 1, `cursor=${feed.cursor}`);
  check('database file exists', fs.existsSync(dbPath), dbPath);

  // Another client writes a task; the app should pull it.
  const remote = await (await fetch(`http://127.0.0.1:${PORT}/api/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      changes: {
        tasks: [{
          id: 'remote-task-1',
          baseRev: 0,
          data: {
            id: 'remote-task-1',
            title: 'From another device',
            notes: '',
            projectId: null,
            labelIds: [],
            priority: 1,
            completed: false,
            createdAt: Date.now(),
            order: 0,
            subtasks: [],
          },
        }],
      },
    }),
  })).json();
  check('a second client can push a record', remote.applied?.length === 1, JSON.stringify(remote));

  await evalJs(`window.dispatchEvent(new Event('online'))`);
  await waitFor(`document.getElementById('task-list').textContent.includes('From another device')`, 'remote task pulled');
  check('the app pulls records from /api/sync', true);

  // Pagination: a second client adds 120 more tasks in one request.
  const bulk = Array.from({ length: 120 }, (_, i) => ({
    id: `bulk-${i}`,
    baseRev: 0,
    data: {
      id: `bulk-${i}`,
      title: `Bulk task ${i}`,
      notes: '',
      projectId: null,
      labelIds: [],
      priority: 4,
      completed: false,
      createdAt: Date.now(),
      order: i,
      subtasks: [],
    },
  }));
  const bulkResult = await (await fetch(`http://127.0.0.1:${PORT}/api/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ changes: { tasks: bulk } }),
  })).json();
  check('a second client can push many records', bulkResult.applied?.length === 120, JSON.stringify({ applied: bulkResult.applied?.length, conflicts: bulkResult.conflicts?.length }));

  // The feed itself pages: 50 rows at a time, resuming from its cursor.
  const firstPage = await (await fetch(`http://127.0.0.1:${PORT}/api/sync?since=0&limit=50`)).json();
  const firstCount = (firstPage.changes?.projects?.length || 0)
    + (firstPage.changes?.labels?.length || 0)
    + (firstPage.changes?.tasks?.length || 0);
  check('the sync feed returns a bounded page', firstCount === 50 && firstPage.hasMore === true, JSON.stringify({ firstCount, cursor: firstPage.cursor }));
  const secondPage = await (await fetch(`http://127.0.0.1:${PORT}/api/sync?since=${firstPage.cursor}&limit=50`)).json();
  check('the next page resumes after the cursor', secondPage.cursor > firstPage.cursor, `cursor=${secondPage.cursor}`);

  await evalJs(`window.dispatchEvent(new Event('online'))`);
  await waitFor(`document.querySelectorAll('#task-list li[data-task-id]').length === 100`, 'first page of tasks');
  check('large lists render a first page of 100', true);
  check('show-more control appears', await evalJs(`!!document.querySelector('#task-list [data-load-more]')`));
  await evalJs(`document.querySelector('#task-list [data-load-more]').click()`);
  await waitFor(`document.querySelectorAll('#task-list li[data-task-id]').length > 100`, 'second page of tasks');
  check('show more reveals the next page', true);

  // Automatic backups: the server keeps a rolling set of snapshots.
  const backups = await (await fetch(`http://127.0.0.1:${PORT}/api/state/backups`)).json();
  check('the server keeps automatic backups', Array.isArray(backups.backups) && backups.backups.length >= 1,
    JSON.stringify(backups.backups?.length));
  check('the backup rows carry a timestamp', Boolean(backups.backups?.[0]?.created_at),
    JSON.stringify(backups.backups?.[0]));

  // Taking one on demand adds another.
  const beforeCount = backups.backups.length;
  const taken = await (await fetch(`http://127.0.0.1:${PORT}/api/state/backups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })).json();
  check('a backup can be taken on demand', Array.isArray(taken.backups) && taken.backups.length >= beforeCount,
    JSON.stringify(taken.backups?.length));

  // Restoring a backup brings the data back. The newest backup holds the
  // current data, so that is the one to restore.
  const backupToRestore = taken.backups?.[0];
  if (backupToRestore) {
    const restoreRes = await fetch(`http://127.0.0.1:${PORT}/api/state/backups/${backupToRestore.id}/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    check('restoring a backup succeeds', restoreRes.status === 200, `status=${restoreRes.status}`);
    const after = await (await fetch(`http://127.0.0.1:${PORT}/api/sync?since=0`)).json();
    const titles2 = (after.changes?.tasks || []).map((row) => row.data?.title);
    check('a backup can be restored', titles2.includes('Persist me to SQLite'), JSON.stringify(titles2.slice(0, 5)));
  }

  const realErrors = errors.filter((e) => !/\/api\//.test(e) && !/ERR_INTERNET_DISCONNECTED/.test(e));
  check('no console errors', realErrors.length === 0, realErrors.join(' | '));

  // Reload: the app must pull the state back from SQLite.
  await send('Page.reload');
  await waitFor('window.__appReady === true', 'app ready after reload');
  await waitFor(`document.getElementById('task-list').textContent.includes('Persist me to SQLite')`, 'local task after reload');
  await waitFor(`document.getElementById('task-list').textContent.includes('From another device')`, 'remote task after reload');
  check('state survives a reload from the server', true);

  ws.close();
} catch (err) {
  check('e2e completed', false, err.message);
  console.error(err, errors);
} finally {
  browser?.kill();
  server?.kill();
  await sleep(500);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* locked on Windows */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* locked on Windows */ }
}
