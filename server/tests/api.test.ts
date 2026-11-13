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

async function withServer(fn: (base: string, cookie: string) => Promise<void>) {
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  try {
    let res = await fetch(`${base}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'api@test.com', password: 'password123', name: 'A' }) });
    if (res.status === 409) res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'api@test.com', password: 'password123' }) });
    const cookie = (res.headers.getSetCookie?.() || [res.headers.get('set-cookie')]).filter(Boolean).map(c => c!.split(';')[0]).join('; ');
    await fn(base, cookie);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

const json = (body: unknown): RequestInit => ({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('state starts empty', async () => {
  await withServer(async (base, cookie) => {
    const res = await fetch(`${base}/api/state`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { data: { projects: [], labels: [], tasks: [] }, rev: 0, updatedAt: null });
  });
});

test('state round-trips and bumps the revision', async () => {
  await withServer(async (base, cookie) => {
    const first = { tasks: [{ id: 't1', title: 'Write plan' }], projects: [] };
    let res = await fetch(`${base}/api/state`, { ...json({ data: first, baseRev: 0 }), headers: { 'content-type': 'application/json', cookie } });
    assert.equal(res.status, 200);
    let body = await res.json() as { rev: number };
    assert.equal(body.rev, 1);

    res = await fetch(`${base}/api/state`, { headers: { cookie } });
    body = await res.json() as { data: unknown; rev: number };
    assert.equal(res.status, 200);
    assert.deepEqual((body as unknown as { data: unknown }).data, { projects: [], labels: [], tasks: [{ id: 't1', title: 'Write plan' }] });

    res = await fetch(`${base}/api/state`, { ...json({ data: { tasks: [] }, baseRev: 1 }), headers: { 'content-type': 'application/json', cookie } });
    assert.equal(res.status, 200);
    body = await res.json() as { rev: number };
    assert.equal(body.rev, 2);
  });
});

test('a stale baseRev is a conflict and does not overwrite', async () => {
  await withServer(async (base, cookie) => {
    const before = await (await fetch(`${base}/api/state`, { headers: { cookie } })).json() as { rev: number; data: unknown };
    const res = await fetch(`${base}/api/state`, { ...json({ data: { tasks: ['stale'] }, baseRev: 999 }), headers: { 'content-type': 'application/json', cookie } });
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
  await withServer(async (base, cookie) => {
    const key = 'todoist-clone-settings';
    let res = await fetch(`${base}/api/docs/${encodeURIComponent(key)}`, { ...json({ data: { theme: 'dark' } }), headers: { 'content-type': 'application/json', cookie } });
    assert.equal(res.status, 200);
    assert.equal((await res.json() as { rev: number }).rev, 1);

    res = await fetch(`${base}/api/docs/${encodeURIComponent(key)}`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json() as { data: unknown }).data, { theme: 'dark' });

    res = await fetch(`${base}/api/docs/${encodeURIComponent(key)}`, { method: 'DELETE', headers: { cookie } });
    assert.equal(res.status, 204);

    res = await fetch(`${base}/api/docs/${encodeURIComponent(key)}`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.equal((await res.json() as { data: unknown }).data, null);
  });
});

test('blobs round-trip as bytes with their metadata', async () => {
  await withServer(async (base, cookie) => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    let res = await fetch(`${base}/api/blobs/att-1`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'note.bin', cookie }, body: bytes });
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

    res = await fetch(`${base}/api/blobs/att-1`, { method: 'DELETE', headers: { cookie } });
    assert.equal(res.status, 204);
    res = await fetch(`${base}/api/blobs/att-1`, { headers: { cookie } });
    assert.equal(res.status, 404);
  });
});

test('state backups keep a copy under the tag', async () => {
  await withServer(async (base, cookie) => {
    const stateRes = await fetch(`${base}/api/state`, { headers: { cookie } });
    assert.equal(stateRes.status, 200);
    const state = await stateRes.json() as { rev: number };
    const put = await fetch(`${base}/api/state`, { ...json({ data: { tasks: [{ id: 'backup-me' }] }, baseRev: state.rev }), headers: { 'content-type': 'application/json', cookie } });
    assert.equal(put.status, 200);
    const res = await fetch(`${base}/api/state/backup/pre-import`, { method: 'POST', headers: { cookie } });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { ok: true, tag: 'pre-import' });
  });
});
