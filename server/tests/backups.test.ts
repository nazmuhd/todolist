import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.SESSION_SECRET = 'test-secret-please-change-me-1234';
process.env.AUTH_RATE_MAX = '1000';
delete process.env.QUIET_HOURS_START;
delete process.env.QUIET_HOURS_END;

const { createApp } = await import('../src/index.ts');
const { migrate } = await import('../src/db/migrate.ts');
const { applyChanges, listBackups, pruneBackups, maybeBackup, readBackup } = await import('../src/db/repository.ts');
const { getDb } = await import('../src/db/index.ts');
await migrate();

const app = createApp({ serveApp: false });

// Seed a user for repository-level operations and HTTP auth.
const db = getDb();
const u = db.prepare("INSERT INTO users (email,name,password_hash,hash_algorithm) VALUES ('backup@test.com','B','x','argon2id')").run();
const USER_ID = Number(u.lastInsertRowid);

async function withServer(fn: (base: string, cookie: string, authed: any) => Promise<void>) {
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  try {
    const jar = (r: Response, prev='') => { const map = new Map<string,string>(); for (const part of [prev, ...((r.headers.getSetCookie?.() || [r.headers.get('set-cookie')]).filter(Boolean).map(c => c!.split(';')[0]))].filter(Boolean).join('; ').split(';')) { const p=part.trim(); if(!p) continue; const i=p.indexOf('='); if(i<0) continue; map.set(p.slice(0,i), p.slice(i+1)); } return [...map.entries()].map(([k,v])=>`${k}=${v}`).join('; '); };
    const state = { cookie: '' };
    const getCsrf = async () => { const r = await fetch(`${base}/auth/csrf`, { headers: state.cookie ? { cookie: state.cookie } : {} }); state.cookie = jar(r, state.cookie); const d = await r.json().catch(()=>({} as any)); return (d as any).csrfToken as string|undefined; };
    const authed = async (path: string, init: RequestInit = {}, cookieArg?: string) => { if (cookieArg !== undefined) state.cookie = cookieArg; const method = String(init.method||'GET').toUpperCase(); const headers: Record<string,string> = { ...(init.headers as any||{}) }; if (!['GET','HEAD','OPTIONS'].includes(method)) { const token = await getCsrf(); if (token) headers['x-csrf-token'] = token; } if (state.cookie) headers.cookie = state.cookie; const r = await fetch(`${base}${path}`, { ...init, headers }); const set = jar(r); if (set) state.cookie = jar(r, state.cookie); return r; };
    let res = await authed('/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'http-backup@test.com', password: 'password123', name: 'H' }) }, '');
    state.cookie = jar(res);
    let cookie = state.cookie;
    if (res.status === 409) { res = await authed('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'http-backup@test.com', password: 'password123' }) }, cookie); state.cookie = jar(res, state.cookie); cookie = state.cookie; }
    await fn(base, cookie, authed);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

interface BackupRow { id: number; tag: string; created_at: string; size: number; }
interface BackupsResponse { ok?: boolean; written?: boolean; backups: BackupRow[]; }

function pushTask(id: string, title: string) {
  return applyChanges(USER_ID, { tasks: [{ id, baseRev: 0, data: { id, title, priority: 4, completed: false, labels: [], order: 0 } }] });
}

test('a backup is taken when data arrives', () => {
  pushTask('b1', 'Backup me');
  const written = maybeBackup(USER_ID, 0, 24);
  assert.equal(written, true);
  const backups = listBackups(USER_ID);
  assert.equal(backups.length, 1);
  assert.match(backups[0]!.tag, /^auto-/);
  assert.ok(backups[0]!.created_at);
});

test('a backup is not taken again before the interval', () => {
  const before = listBackups(USER_ID).length;
  const written = maybeBackup(USER_ID, 60 * 60 * 1000, 24);
  assert.equal(written, false);
  assert.equal(listBackups(USER_ID).length, before);
});

test('the old backups are pruned, the newest kept', () => {
  for (let i = 0; i < 5; i += 1) maybeBackup(USER_ID, 0, 3);
  const backups = listBackups(USER_ID);
  assert.ok(backups.length <= 3, `expected at most 3 backups, got ${backups.length}`);
  const all = listBackups(USER_ID, 100);
  assert.equal(all[0]!.id, backups[0]!.id);
});

test('pruning keeps exactly the requested number', () => {
  for (let i = 0; i < 6; i += 1) maybeBackup(USER_ID, 0, 24);
  const removed = pruneBackups(USER_ID, 2);
  assert.ok(removed >= 1);
  assert.equal(listBackups(USER_ID).length, 2);
});

test('a backup holds the data that can be restored', () => {
  maybeBackup(USER_ID, 0, 24);
  const latest = listBackups(USER_ID)[0]!;
  const value = readBackup(USER_ID, latest.id);
  assert.ok(value);
  const parsed = JSON.parse(value);
  assert.ok(Array.isArray(parsed.tasks));
  assert.ok(parsed.tasks.some((t: { id: string }) => t.id === 'b1'));
});

test('GET /api/state/backups lists the automatic backups', async () => {
  await withServer(async (base, cookie, authed) => {
    const res = await fetch(`${base}/api/state/backups`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json() as BackupsResponse;
    assert.ok(Array.isArray(body.backups));
  });
});

test('POST /api/state/backups takes one on demand', async () => {
  await withServer(async (base, cookie, authed) => {
    // ensure there is data to back up for this HTTP user
    await authed('/api/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changes: { tasks: [{ id: 'hb1', baseRev: 0, data: { id: 'hb1', title: 'HB', priority: 4, completed: false, labels: [], order: 0 } }] } }) }, cookie);
    const before = (await (await fetch(`${base}/api/state/backups`, { headers: { cookie } })).json() as BackupsResponse).backups.length;
    const res = await authed('/api/state/backups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) }, cookie);
    assert.equal(res.status, 200);
    const body = await res.json() as BackupsResponse;
    assert.equal(body.written, true);
    assert.ok(body.backups.length > before);
  });
});

test('an on-demand backup holds the data as it is now', async () => {
  await withServer(async (base, cookie, authed) => {
    await authed('/api/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changes: { tasks: [{ id: 'later-task', baseRev: 0, data: { id: 'later-task', title: 'Added later', priority: 4, completed: false, labels: [], order: 0 } }] } }) }, cookie);
    const taken = await (await authed('/api/state/backups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) }, cookie)).json() as BackupsResponse;
    const newest = taken.backups[0]!;
    // HTTP user is different from USER_ID; fetch backup via API restore flow or read from DB by finding its user - easier: read via API state export after restore not needed. We can query DB for that backup id regardless of user? readBackup now requires userId.
    const httpUser = (db.prepare("SELECT id FROM users WHERE email='http-backup@test.com'").get() as any).id as number;
    const value = readBackup(httpUser, newest.id);
    const parsed = JSON.parse(value!) as { tasks: { id: string }[] };
    assert.ok(parsed.tasks.some(t => t.id === 'later-task'), 'the on-demand backup should include the task that was just added');
  });
});

test('a backup can be restored over the API', async () => {
  await withServer(async (base, cookie, authed) => {
    await authed('/api/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changes: { tasks: [{ id: 'restore-me', baseRev: 0, data: { id: 'restore-me', title: 'Restore me', priority: 4, completed: false, labels: [], order: 0 } }] } }) }, cookie);
    const taken = await (await authed('/api/state/backups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ intervalMinutes: 0 }) }, cookie)).json() as BackupsResponse;
    const backup = taken.backups[0]!;
    await authed('/api/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changes: { tasks: [{ id: 'restore-me', baseRev: 1, data: { id: 'restore-me', title: 'Changed', priority: 4, completed: false, labels: [], order: 0 } }] } }) }, cookie);
    const res = await authed(`/api/state/backups/${backup.id}/restore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) }, cookie);
    assert.equal(res.status, 200);
    const feed = await (await fetch(`${base}/api/sync?since=0`, { headers: { cookie } })).json() as { changes?: { tasks?: { data?: { title?: string } }[] } };
    const titles = (feed.changes?.tasks || []).map((row) => row.data?.title);
    assert.ok(titles.includes('Restore me'), `expected the restored title, got ${JSON.stringify(titles)}`);
  });
});

test('restoring a backup that does not exist is a 404', async () => {
  await withServer(async (base, cookie, authed) => {
    const res = await authed('/api/state/backups/999999/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) }, cookie);
    assert.equal(res.status, 404);
  });
});
