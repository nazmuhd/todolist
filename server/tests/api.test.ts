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
await migrate();

const app = createApp({ serveApp: false });

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
    let res = await authed('/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'api@test.com', password: 'password123', name: 'A' }) }, '');
    state.cookie = jar(res);
    let cookie = state.cookie;
    if (res.status === 409) { res = await authed('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'api@test.com', password: 'password123' }) }, cookie); state.cookie = jar(res, state.cookie); cookie = state.cookie; }
    await fn(base, cookie, authed);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

const json = (body: unknown): RequestInit => ({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('state starts empty', async () => {
  await withServer(async (base, cookie, authed) => {
    const res = await fetch(`${base}/api/state`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { data: { projects: [], labels: [], tasks: [] }, rev: 0, updatedAt: null });
  });
});

test('state round-trips and bumps the revision', async () => {
  await withServer(async (base, cookie, authed) => {
    const first = { tasks: [{ id: 't1', title: 'Write plan' }], projects: [] };
    let res = await authed('/api/state', json({ data: first, baseRev: 0 }), cookie);
    assert.equal(res.status, 200);
    let body = await res.json() as { rev: number };
    assert.equal(body.rev, 1);

    res = await fetch(`${base}/api/state`, { headers: { cookie } });
    body = await res.json() as { data: unknown; rev: number };
    assert.equal(res.status, 200);
    assert.deepEqual((body as unknown as { data: unknown }).data, { projects: [], labels: [], tasks: [{ id: 't1', title: 'Write plan' }] });

    res = await authed('/api/state', json({ data: { tasks: [] }, baseRev: 1 }), cookie);
    assert.equal(res.status, 200);
    body = await res.json() as { rev: number };
    assert.equal(body.rev, 2);
  });
});

test('a stale baseRev is a conflict and does not overwrite', async () => {
  await withServer(async (base, cookie, authed) => {
    const before = await (await fetch(`${base}/api/state`, { headers: { cookie } })).json() as { rev: number; data: unknown };
    const res = await authed('/api/state', json({ data: { tasks: ['stale'] }, baseRev: 999 }), cookie);
    assert.equal(res.status, 409);
    const conflict = await res.json() as { error: string; rev: number };
    assert.equal(conflict.error, 'conflict');
    assert.equal(conflict.rev, before.rev);
    const after = await (await fetch(`${base}/api/state`, { headers: { cookie } })).json() as { rev: number; data: unknown };
    assert.equal(after.rev, before.rev);
    assert.deepEqual(after.data, before.data);
  });
});

test('documents round-trip and delete', async () => {
  await withServer(async (base, cookie, authed) => {
    const key = 'todoist-clone-settings';
    let res = await authed(`/api/docs/${encodeURIComponent(key)}`, json({ data: { theme: 'dark' } }), cookie);
    assert.equal(res.status, 200);
    assert.equal((await res.json() as { rev: number }).rev, 1);

    res = await fetch(`${base}/api/docs/${encodeURIComponent(key)}`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json() as { data: unknown }).data, { theme: 'dark' });

    res = await authed(`/api/docs/${encodeURIComponent(key)}`, { method: 'DELETE' }, cookie);
    assert.equal(res.status, 204);

    res = await fetch(`${base}/api/docs/${encodeURIComponent(key)}`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.equal((await res.json() as { data: unknown }).data, null);
  });
});

test('blobs round-trip as bytes with their metadata', async () => {
  await withServer(async (base, cookie, authed) => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    let res = await authed('/api/blobs/att-1', { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'note.bin' }, body: bytes }, cookie);
    assert.equal(res.status, 200);
    const meta = await res.json() as { key: string; size: number; name: string; rev: number };
    assert.equal(meta.key, 'att-1');
    assert.equal(meta.size, 5);
    assert.equal(meta.name, 'note.bin');
    assert.equal(meta.rev, 1);

    res = await fetch(`${base}/api/blobs/att-1`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes);

    res = await fetch(`${base}/api/blobs`, { headers: { cookie } });
    const list = await res.json() as { key: string; size: number }[];
    assert.equal(list.length, 1);
    assert.equal(list[0]?.key, 'att-1');

    res = await authed('/api/blobs/att-1', { method: 'DELETE' }, cookie);
    assert.equal(res.status, 204);
    res = await fetch(`${base}/api/blobs/att-1`, { headers: { cookie } });
    assert.equal(res.status, 404);
  });
});

test('state backups keep a copy under the tag', async () => {
  await withServer(async (base, cookie, authed) => {
    const stateRes = await fetch(`${base}/api/state`, { headers: { cookie } });
    assert.equal(stateRes.status, 200);
    const state = await stateRes.json() as { rev: number };
    const put = await authed('/api/state', json({ data: { tasks: [{ id: 'backup-me' }] }, baseRev: state.rev }), cookie);
    assert.equal(put.status, 200);
    const res = await authed('/api/state/backup/pre-import', { method: 'POST' }, cookie);
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { ok: true, tag: 'pre-import' });
  });
});
