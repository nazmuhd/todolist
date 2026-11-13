import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 4600;
const BASE = `http://127.0.0.1:${PORT}`;
let child: ChildProcess | undefined;
let dbDir: string | undefined;

async function waitReady(base: string) {
  for (let i = 0; i < 100; i++) { try { const r = await fetch(`${base}/health`); if (r.ok) return; } catch {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error('server did not start');
}

function cookieJar(res: Response): string {
  const raw = (res.headers as any).getSetCookie?.() ?? [res.headers.get('set-cookie')];
  return (raw as string[]).filter(Boolean).map((c: string) => c.split(';')[0]).join('; ');
}
function mergeCookies(a?: string, b?: string) {
  const map = new Map<string,string>();
  for (const part of [a,b].filter(Boolean).join('; ').split(';')) {
    const p = part.trim(); if (!p) continue; const i = p.indexOf('='); if (i<0) continue; map.set(p.slice(0,i), p.slice(i+1));
  }
  return [...map.entries()].map(([k,v])=>`${k}=${v}`).join('; ');
}
async function csrf(base: string, cookies?: string) {
  const res = await fetch(`${base}/auth/csrf`, { headers: cookies ? { cookie: cookies } : {} });
  const jar = mergeCookies(cookies, cookieJar(res));
  const data = await res.json().catch(() => ({} as any));
  return { token: (data as any).csrfToken as string | undefined, cookies: jar };
}
async function authed(base: string, path: string, init: RequestInit, state: { cookie: string }) {
  const method = String(init.method || 'GET').toUpperCase();
  const headers: Record<string, string> = { ...(init.headers as any || {}) };
  if (!['GET','HEAD','OPTIONS'].includes(method)) {
    const c = await csrf(base, state.cookie);
    state.cookie = c.cookies;
    if (c.token) headers['x-csrf-token'] = c.token;
  }
  if (state.cookie) headers.cookie = state.cookie;
  const res = await fetch(`${base}${path}`, { ...init, headers });
  const set = cookieJar(res);
  if (set) state.cookie = mergeCookies(state.cookie, set);
  return res;
}

test.before(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'sync-test-'));
  const dbPath = join(dbDir, 'todoist.db');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.close();
  child = spawn(process.execPath, ['--experimental-strip-types', join(here, '..', 'src', 'server.ts')], {
    env: { ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_PATH: dbPath, SESSION_SECRET: 'test-secret-please-change-me-1234', QUIET_HOURS_START: '', QUIET_HOURS_END: '', AUTH_RATE_MAX: '1000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr?.on('data', d => process.stderr.write(d));
  await waitReady(BASE);
});
test.after(() => { child?.kill('SIGKILL'); try { if (dbDir) rmSync(dbDir, { recursive: true, force: true }); } catch {} });

const post = (changes: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changes }) });
interface SyncResponse { applied: { entity: string; id: string; rev: number }[]; conflicts: { entity: string; id: string; rev: number; deleted: boolean }[]; cursor: number; }

test('sync flow with auth', async () => {
  const state = { cookie: '' };
  const reg = await authed(BASE, '/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'sync2@test.com', password: 'password123', name: 'S' }) }, state);
  let cookie = state.cookie;
  assert.equal(reg.status, 201);

  let res = await fetch(`${BASE}/api/sync?since=0`, { headers: { cookie: state.cookie } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { changes: { projects: [], labels: [], tasks: [] }, cursor: 0, hasMore: false });

  res = await authed(BASE, '/api/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changes: { tasks: [{ id: 't1', data: { id: 't1', title: 'Write plan' }, baseRev: 0 }], projects: [{ id: 'p1', data: { id: 'p1', name: 'Work' }, baseRev: 0 }] } }) }, state);
  assert.equal(res.status, 200);
  const body = await res.json() as SyncResponse;
  assert.equal(body.conflicts.length, 0);
  assert.equal(body.applied.length, 2);
  assert.equal(body.cursor, 2);

  const feed = await (await fetch(`${BASE}/api/sync?since=0`, { headers: { cookie: state.cookie } })).json() as any;
  assert.equal(feed.cursor, 2);
  assert.equal(feed.changes.tasks[0].data.title, 'Write plan');
  assert.equal(feed.changes.tasks[0].rev, 1);

  // stale baseRev
  res = await authed(BASE, '/api/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changes: { tasks: [ { id: 't1', data: { id: 't1', title: 'Stale edit' }, baseRev: 0 }, { id: 't2', data: { id: 't2', title: 'Fresh task' }, baseRev: 0 } ] } }) }, state);
  const body2 = await res.json() as SyncResponse;
  assert.equal(body2.conflicts.length, 1);
  assert.equal(body2.conflicts[0]?.id, 't1');
  assert.equal(body2.applied.length, 1);

  // retry with correct baseRev
  res = await authed(BASE, '/api/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changes: { tasks: [{ id: 't1', data: { id: 't1', title: 'Client wins' }, baseRev: 1 }] } }) }, state);
  const body3 = await res.json() as SyncResponse;
  assert.equal(body3.conflicts.length, 0);
  assert.equal(body3.applied[0]?.rev, 2);

  // delete
  res = await authed(BASE, '/api/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changes: { tasks: [{ id: 't2', deleted: true, baseRev: 1 }] } }) }, state);
  assert.equal(res.status, 200);
  const feed2 = await (await fetch(`${BASE}/api/sync?since=${body3.cursor}`, { headers: { cookie: state.cookie } })).json() as any;
  assert.equal(feed2.changes.tasks[0]?.deleted, true);

  // state reflects
  res = await fetch(`${BASE}/api/state`, { headers: { cookie: state.cookie } });
  const st = await res.json() as any;
  assert.deepEqual(st.data.tasks.map((t: any) => t.id), ['t1']);
});
