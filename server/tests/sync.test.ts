import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';

const { createApp } = await import('../src/index.ts');
const { migrate } = await import('../src/db/migrate.ts');
await migrate();

const app = createApp({ serveApp: false });

async function withServer(fn: (base: string) => Promise<void>) {
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

const post = (changes: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ changes }),
});

interface SyncResponse {
  applied: { entity: string; id: string; rev: number }[];
  conflicts: { entity: string; id: string; rev: number; deleted: boolean }[];
  cursor: number;
}

test('an empty sync feed starts at cursor 0', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/sync?since=0`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      changes: { projects: [], labels: [], tasks: [] },
      cursor: 0,
      hasMore: false,
    });
  });
});

test('records push individually and appear in the feed', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/sync`, post({
      tasks: [{ id: 't1', data: { id: 't1', title: 'Write plan' }, baseRev: 0 }],
      projects: [{ id: 'p1', data: { id: 'p1', name: 'Work' }, baseRev: 0 }],
    }));
    assert.equal(res.status, 200);
    const body = await res.json() as SyncResponse;
    assert.equal(body.conflicts.length, 0);
    assert.equal(body.applied.length, 2);
    assert.equal(body.cursor, 2);

    const feed = await (await fetch(`${base}/api/sync?since=0`)).json() as {
      changes: { tasks: { id: string; data: { title: string }; rev: number }[]; projects: unknown[] };
      cursor: number;
    };
    assert.equal(feed.cursor, 2);
    assert.equal(feed.changes.tasks.length, 1);
    assert.equal(feed.changes.tasks[0]?.data.title, 'Write plan');
    assert.equal(feed.changes.tasks[0]?.rev, 1);
    assert.equal(feed.changes.projects.length, 1);

    const later = await (await fetch(`${base}/api/sync?since=2`)).json() as { changes: { tasks: unknown[] } };
    assert.equal(later.changes.tasks.length, 0);
  });
});

test('a stale baseRev conflicts for that record only', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/sync`, post({
      tasks: [
        { id: 't1', data: { id: 't1', title: 'Stale edit' }, baseRev: 0 },
        { id: 't2', data: { id: 't2', title: 'Fresh task' }, baseRev: 0 },
      ],
    }));
    const body = await res.json() as SyncResponse;

    assert.equal(body.conflicts.length, 1);
    assert.equal(body.conflicts[0]?.id, 't1');
    assert.equal(body.conflicts[0]?.rev, 1);
    assert.equal(body.applied.length, 1);
    assert.equal(body.applied[0]?.id, 't2');

    const feed = await (await fetch(`${base}/api/sync?since=2`)).json() as {
      changes: { tasks: { id: string; data: { title: string } }[] };
    };
    assert.equal(feed.changes.tasks.length, 1);
    assert.equal(feed.changes.tasks[0]?.id, 't2');
    assert.equal(feed.changes.tasks[0]?.data.title, 'Fresh task');
  });
});

test('a retry with the conflict revision applies the edit', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/sync`, post({
      tasks: [{ id: 't1', data: { id: 't1', title: 'Client wins' }, baseRev: 1 }],
    }));
    const body = await res.json() as SyncResponse;
    assert.equal(body.conflicts.length, 0);
    assert.equal(body.applied[0]?.rev, 2);
  });
});

test('deletes become tombstones in the feed', async () => {
  await withServer(async (base) => {
    const before = await (await fetch(`${base}/api/sync?since=0`)).json() as { cursor: number };
    const res = await fetch(`${base}/api/sync`, post({
      tasks: [{ id: 't2', deleted: true, baseRev: 1 }],
    }));
    assert.equal(res.status, 200);
    const body = await res.json() as SyncResponse;
    assert.equal(body.conflicts.length, 0);

    const feed = await (await fetch(`${base}/api/sync?since=${before.cursor}`)).json() as {
      changes: { tasks: { id: string; deleted?: boolean; rev: number }[] };
    };
    assert.equal(feed.changes.tasks.length, 1);
    assert.equal(feed.changes.tasks[0]?.id, 't2');
    assert.equal(feed.changes.tasks[0]?.deleted, true);
    assert.equal(feed.changes.tasks[0]?.rev, 2);
  });
});

test('the whole-state endpoint reflects entity rows and tombstones', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/state`);
    const body = await res.json() as { data: { tasks: { id: string }[]; projects: unknown[] } };
    assert.deepEqual(body.data.tasks.map(t => t.id), ['t1']);
    assert.equal(body.data.projects.length, 1);
  });
});

test('invalid sync payloads are rejected', async () => {
  await withServer(async (base) => {
    let res = await fetch(`${base}/api/sync`, post({ tasks: [{ id: '' }] }));
    assert.equal(res.status, 400);

    res = await fetch(`${base}/api/sync`, post({ tasks: [{ id: 'x', data: { id: 'x' }, baseRev: -1 }] }));
    assert.equal(res.status, 400);

    res = await fetch(`${base}/api/sync`, post({ tasks: [{ id: 'x' }] }));
    assert.equal(res.status, 400);
  });
});
