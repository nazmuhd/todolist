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
    let res = await fetch(`${base}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'page@test.com', password: 'password123', name: 'P' }) });
    if (res.status === 409) res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'page@test.com', password: 'password123' }) });
    const cookie = (res.headers.getSetCookie?.() || [res.headers.get('set-cookie')]).filter(Boolean).map(c => c!.split(';')[0]).join('; ');
    await fn(base, cookie);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

interface Feed { changes: { projects: { id: string }[]; labels: { id: string }[]; tasks: { id: string }[] }; cursor: number; hasMore: boolean; }
function count(feed: Feed): number { return feed.changes.projects.length + feed.changes.labels.length + feed.changes.tasks.length; }

async function seed(base: string, cookie: string) {
  const changes = { tasks: [ { id: 't1', data: { id: 't1', title: 'One' }, baseRev: 0 }, { id: 't2', data: { id: 't2', title: 'Two' }, baseRev: 0 }, { id: 't3', data: { id: 't3', title: 'Three' }, baseRev: 0 } ] };
  const res = await fetch(`${base}/api/sync`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ changes }) });
  assert.equal(res.status, 200);
}

test('the feed can be paged with a cursor', async () => {
  await withServer(async (base, cookie) => {
    await seed(base, cookie);
    let res = await fetch(`${base}/api/sync?since=0&limit=2`, { headers: { cookie } });
    assert.equal(res.status, 200);
    let feed = await res.json() as Feed;
    assert.equal(count(feed), 2);
    assert.equal(feed.hasMore, true);
    assert.equal(feed.cursor, 2);
    assert.deepEqual(feed.changes.tasks.map(t => t.id), ['t1', 't2']);

    res = await fetch(`${base}/api/sync?since=${feed.cursor}&limit=2`, { headers: { cookie } });
    feed = await res.json() as Feed;
    assert.equal(count(feed), 1);
    assert.equal(feed.hasMore, false);
    assert.equal(feed.cursor, 3);
    assert.deepEqual(feed.changes.tasks.map(t => t.id), ['t3']);

    res = await fetch(`${base}/api/sync?since=${feed.cursor}&limit=2`, { headers: { cookie } });
    feed = await res.json() as Feed;
    assert.equal(count(feed), 0);
    assert.equal(feed.hasMore, false);
    assert.equal(feed.cursor, 3);
  });
});

test('without a limit the whole feed comes back', async () => {
  await withServer(async (base, cookie) => {
    const res = await fetch(`${base}/api/sync?since=0`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const feed = await res.json() as Feed;
    assert.equal(count(feed), 3);
    assert.equal(feed.hasMore, false);
    assert.equal(feed.cursor, 3);
  });
});

test('invalid limits are rejected', async () => {
  await withServer(async (base, cookie) => {
    for (const limit of ['0', '-1', 'abc', '1001', '1.5']) {
      const res = await fetch(`${base}/api/sync?since=0&limit=${limit}`, { headers: { cookie } });
      assert.equal(res.status, 400, `limit=${limit}`);
      assert.deepEqual(await res.json(), { error: 'invalid_limit' });
    }
  });
});

test('tombstones respect the page cursor too', async () => {
  await withServer(async (base, cookie) => {
    const res = await fetch(`${base}/api/sync`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ changes: { tasks: [{ id: 't3', deleted: true, baseRev: 1 }] } }) });
    assert.equal(res.status, 200);
    const feed = await (await fetch(`${base}/api/sync?since=3&limit=1`, { headers: { cookie } })).json() as Feed & { changes: { tasks: { id: string; deleted?: boolean }[] } };
    assert.equal(feed.cursor, 4);
    assert.equal(feed.hasMore, false);
    assert.equal(feed.changes.tasks[0]?.id, 't3');
    assert.equal(feed.changes.tasks[0]?.deleted, true);
  });
});
