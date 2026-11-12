import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';

const { createApp } = await import('../src/index.ts');
const { migrate } = await import('../src/db/migrate.ts');
const { applyChanges, listBackups, pruneBackups, maybeBackup, readBackup } = await import('../src/db/repository.ts');
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

interface BackupRow {
  id: number;
  tag: string;
  created_at: string;
  size: number;
}

interface BackupsResponse {
  ok?: boolean;
  written?: boolean;
  backups: BackupRow[];
}

function pushTask(id: string, title: string) {
  return applyChanges({
    tasks: [{ id, baseRev: 0, data: { id, title, priority: 4, completed: false, labels: [], order: 0 } }],
  });
}

test('a backup is taken when data arrives', () => {
  pushTask('b1', 'Backup me');
  // The interval is zero, so a backup is always due.
  const written = maybeBackup(0, 24);
  assert.equal(written, true);
  const backups = listBackups();
  assert.equal(backups.length, 1);
  assert.match(backups[0]!.tag, /^auto-/);
  assert.ok(backups[0]!.created_at);
});

test('a backup is not taken again before the interval', () => {
  const before = listBackups().length;
  const written = maybeBackup(60 * 60 * 1000, 24);
  assert.equal(written, false);
  assert.equal(listBackups().length, before);
});

test('the old backups are pruned, the newest kept', () => {
  for (let i = 0; i < 5; i += 1) maybeBackup(0, 3);
  const backups = listBackups();
  assert.ok(backups.length <= 3, `expected at most 3 backups, got ${backups.length}`);
  const all = listBackups(100);
  assert.equal(all[0]!.id, backups[0]!.id);
});

test('pruning keeps exactly the requested number', () => {
  for (let i = 0; i < 6; i += 1) maybeBackup(0, 24);
  const removed = pruneBackups(2);
  assert.ok(removed >= 1);
  assert.equal(listBackups().length, 2);
});

test('a backup holds the data that can be restored', () => {
  maybeBackup(0, 24);
  const latest = listBackups()[0]!;
  const value = readBackup(latest.id);
  assert.ok(value);
  const parsed = JSON.parse(value);
  assert.ok(Array.isArray(parsed.tasks));
  assert.ok(parsed.tasks.some((t: { id: string }) => t.id === 'b1'));
});

test('GET /api/state/backups lists the automatic backups', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/state/backups`);
    assert.equal(res.status, 200);
    const body = await res.json() as BackupsResponse;
    assert.ok(Array.isArray(body.backups));
    assert.ok(body.backups.length >= 1);
  });
});

test('POST /api/state/backups takes one on demand', async () => {
  await withServer(async (base) => {
    const before = (await (await fetch(`${base}/api/state/backups`)).json() as BackupsResponse).backups.length;
    const res = await fetch(`${base}/api/state/backups`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as BackupsResponse;
    // A fresh snapshot is written, even if one was taken moments ago.
    assert.equal(body.written, true);
    assert.ok(body.backups.length > before);
  });
});

test('an on-demand backup holds the data as it is now', async () => {
  await withServer(async (base) => {
    // A task that is added after the server started.
    await fetch(`${base}/api/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        changes: { tasks: [{ id: 'later-task', baseRev: 0, data: { id: 'later-task', title: 'Added later', priority: 4, completed: false, labels: [], order: 0 } }] },
      }),
    });

    const taken = await (await fetch(`${base}/api/state/backups`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })).json() as BackupsResponse;

    const newest = taken.backups[0]!;
    const value = readBackup(newest.id);
    const parsed = JSON.parse(value!) as { tasks: { id: string }[] };
    assert.ok(
      parsed.tasks.some(t => t.id === 'later-task'),
      'the on-demand backup should include the task that was just added',
    );
  });
});

test('a backup can be restored over the API', async () => {
  await withServer(async (base) => {
    // Put a task on the server, back it up, then change the data.
    await fetch(`${base}/api/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        changes: { tasks: [{ id: 'restore-me', baseRev: 0, data: { id: 'restore-me', title: 'Restore me', priority: 4, completed: false, labels: [], order: 0 } }] },
      }),
    });
    const taken = await (await fetch(`${base}/api/state/backups`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intervalMinutes: 0 }),
    })).json() as BackupsResponse;
    const backup = taken.backups[0]!;

    // Now change the data, and restore the backup over it.
    await fetch(`${base}/api/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        changes: { tasks: [{ id: 'restore-me', baseRev: 1, data: { id: 'restore-me', title: 'Changed', priority: 4, completed: false, labels: [], order: 0 } }] },
      }),
    });

    const res = await fetch(`${base}/api/state/backups/${backup.id}/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);

    const feed = await (await fetch(`${base}/api/sync?since=0`)).json() as {
      changes?: { tasks?: { data?: { title?: string } }[] };
    };
    const titles = (feed.changes?.tasks || []).map((row) => row.data?.title);
    assert.ok(titles.includes('Restore me'), `expected the restored title, got ${JSON.stringify(titles)}`);
  });
});

test('restoring a backup that does not exist is a 404', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/state/backups/999999/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 404);
  });
});
