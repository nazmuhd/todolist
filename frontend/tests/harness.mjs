/* Shared headless-browser harness for the frontend tests.
 *
 * Serves frontend/dist on a throwaway port, launches a Chromium-based browser
 * with remote debugging, and exposes a tiny CDP client plus the check helpers
 * the test files use. Requires a prior `pnpm build`.
 *
 * Override the browser with BROWSER=/path/to/browser if it is not in one of
 * the usual Windows/macOS/Linux locations.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DIST = path.resolve(HERE, '../dist');

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { sleep };

function browserCandidates() {
  if (process.env.BROWSER) return [process.env.BROWSER];
  if (process.platform === 'win32') {
    return [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    ];
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ];
  }
  return ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium'];
}

function findBrowser() {
  const found = browserCandidates().find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error('No Chromium-based browser found. Set BROWSER to its executable.');
  }
  return found;
}

function staticServer(port) {
  // A tiny in-memory stand-in for the API, so the UI tests stay independent
  // of the server (which has its own tests). Real API semantics are covered
  // in server/tests.
  const api = { state: null, rev: 0, docs: new Map(), blobs: new Map(), sync: { seq: 0, rows: new Map() } };

  const readBody = (req) => new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
  const sendJson = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };

  async function handleApi(req, res, urlPath, rawUrl) {
    const parts = urlPath.split('/').filter(Boolean); // ['api', ...]
    const section = parts[1];
    const key = parts[2] || ''; // the URL was already decoded above
    const method = req.method || 'GET';

    if (section === 'sync') {
      if (method === 'GET') {
        const since = Number(new URL(rawUrl, 'http://localhost').searchParams.get('since') || 0);
        const changes = { projects: [], labels: [], tasks: [] };
        for (const row of [...api.sync.rows.values()].sort((a, b) => a.seq - b.seq)) {
          if (row.seq <= since) continue;
          changes[row.entity].push({
            id: row.id,
            data: row.deleted ? null : row.data,
            rev: row.rev,
            deleted: row.deleted,
          });
        }
        sendJson(res, 200, { changes, cursor: api.sync.seq });
        return;
      }
      if (method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        const applied = [];
        const conflicts = [];
        for (const entity of ['projects', 'labels', 'tasks']) {
          for (const change of body.changes?.[entity] || []) {
            const rowKey = `${entity}:${change.id}`;
            const current = api.sync.rows.get(rowKey);
            const currentRev = current ? current.rev : 0;
            if ((change.baseRev ?? 0) !== currentRev) {
              conflicts.push({
                entity,
                id: change.id,
                rev: currentRev,
                data: current && !current.deleted ? current.data : null,
                deleted: Boolean(current?.deleted),
              });
              continue;
            }
            const rev = currentRev + 1;
            const seq = api.sync.seq + 1;
            api.sync.seq = seq;
            api.sync.rows.set(rowKey, {
              entity,
              id: change.id,
              data: change.deleted ? null : change.data,
              rev,
              seq,
              deleted: Boolean(change.deleted),
            });
            applied.push({ entity, id: change.id, rev });
          }
        }
        sendJson(res, 200, { applied, conflicts, cursor: api.sync.seq });
        return;
      }
    }

    if (section === 'state') {
      if (parts[2] === 'backup') {
        sendJson(res, 201, { ok: true, tag: key });
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, { data: api.state, rev: api.rev });
        return;
      }
      if (method === 'PUT') {
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        if (body.baseRev !== undefined && body.baseRev !== api.rev) {
          sendJson(res, 409, { error: 'conflict', rev: api.rev });
          return;
        }
        api.state = body.data;
        api.rev += 1;
        sendJson(res, 200, { rev: api.rev });
        return;
      }
    }

    if (section === 'docs') {
      if (method === 'GET') {
        sendJson(res, 200, { data: api.docs.has(key) ? api.docs.get(key) : null, rev: 1 });
        return;
      }
      if (method === 'PUT') {
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        api.docs.set(key, body.data);
        sendJson(res, 200, { rev: 1 });
        return;
      }
      if (method === 'DELETE') {
        api.docs.delete(key);
        res.writeHead(204);
        res.end();
        return;
      }
    }

    if (section === 'blobs') {
      if (!key) {
        sendJson(res, 200, [...api.blobs.entries()].map(([id, b]) => ({
          key: id, name: b.name, mime: b.mime, size: b.data.length, rev: 1,
        })));
        return;
      }
      if (method === 'GET') {
        const blob = api.blobs.get(key);
        if (!blob) { sendJson(res, 404, { error: 'not_found' }); return; }
        res.writeHead(200, { 'content-type': blob.mime });
        res.end(blob.data);
        return;
      }
      if (method === 'PUT') {
        const data = await readBody(req);
        api.blobs.set(key, {
          data,
          mime: req.headers['content-type'] || 'application/octet-stream',
          name: decodeURIComponent(req.headers['x-file-name'] || ''),
        });
        sendJson(res, 200, { key, size: data.length, rev: 1 });
        return;
      }
      if (method === 'DELETE') {
        api.blobs.delete(key);
        res.writeHead(204);
        res.end();
        return;
      }
    }

    sendJson(res, 404, { error: 'not_found' });
  }

  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.startsWith('/api/')) {
      handleApi(req, res, p, req.url).catch((err) => sendJson(res, 500, { error: String(err) }));
      return;
    }
    if (p === '/') p = '/index.html';
    const file = path.join(DIST, p);
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve(server));
  });
}

async function getTarget(debugPort, appPort) {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const list = await res.json();
      const target = list.find((t) => t.type === 'page' && t.url.includes(String(appPort)));
      if (target) return target;
    } catch {
      /* browser still starting */
    }
    await sleep(150);
  }
  throw new Error('no CDP target — the browser did not start');
}

/**
 * @param {{ port?: number, debugPort?: number, width?: number, height?: number }} options
 */
export async function createHarness(options = {}) {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    throw new Error('frontend/dist is missing — run `pnpm build` first.');
  }
  const appPort = options.port ?? 5199;
  const debugPort = options.debugPort ?? 9333;
  const server = await staticServer(appPort);
  const profile = path.join(os.tmpdir(), `todoist-test-${Date.now()}`);
  const browser = spawn(findBrowser(), [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    `http://127.0.0.1:${appPort}/`,
  ], { stdio: 'ignore' });

  let target;
  try {
    target = await getTarget(debugPort, appPort);
  } catch (err) {
    browser.kill();
    server.close();
    throw err;
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let nextId = 1;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      errors.push('EXCEPTION: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push('CONSOLE: ' + msg.params.args.map((a) => a.value ?? a.description).join(' '));
    } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      errors.push('LOG: ' + msg.params.entry.text);
    }
  };

  function send(method, params = {}) {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }

  async function evalJs(expression) {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  }

  async function waitFor(expression, label, timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        if (await evalJs(expression)) return;
      } catch {
        /* page may be navigating */
      }
      await sleep(100);
    }
    throw new Error('timeout: ' + label);
  }

  const results = [];
  function check(name, ok, detail = '') {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  }

  async function close() {
    try { ws.close(); } catch { /* already closed */ }
    browser.kill();
    server.close();
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* locked on Windows */ }
  }

  function finish() {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) console.log('failed:', failed.map((f) => f.name).join(', '));
    return failed.length === 0 ? 0 : 1;
  }

  return { send, evalJs, waitFor, check, results, errors, close, finish };
}
