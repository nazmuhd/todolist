import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';

const { createApp } = await import('../src/index.ts');
const { migrate } = await import('../src/db/migrate.ts');
const { getDb } = await import('../src/db/index.ts');
const { replaceEntities, markReminderFired, getCursor } = await import('../src/db/repository.ts');
const { dueReminders, reminderKey } = await import('../src/services/reminders.ts');
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

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('push endpoints are explicit when VAPID is not configured', async () => {
  await withServer(async (base) => {
    let res = await fetch(`${base}/api/push/key`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'push_disabled' });

    res = await fetch(`${base}/api/push/test`, { method: 'POST' });
    assert.equal(res.status, 404);
  });
});

test('subscriptions validate, store and delete', async () => {
  await withServer(async (base) => {
    let res = await fetch(`${base}/api/push/subscribe`, json('POST', { endpoint: 'nope' }));
    assert.equal(res.status, 400);

    const subscription = {
      endpoint: 'https://push.example.test/abc',
      keys: { p256dh: 'key', auth: 'secret' },
    };
    res = await fetch(`${base}/api/push/subscribe`, json('POST', subscription));
    assert.equal(res.status, 201);

    const stored = getDb().prepare('select endpoint from push_subscriptions').all() as { endpoint: string }[];
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.endpoint, subscription.endpoint);

    res = await fetch(`${base}/api/push/subscribe`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: subscription.endpoint }) });
    assert.equal(res.status, 204);

    res = await fetch(`${base}/api/push/subscribe`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: subscription.endpoint }) });
    assert.equal(res.status, 404);
  });
});

test('due reminders are computed once and recorded', () => {
  const now = new Date();
  const due = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  const fireTime = new Date(now.getTime() - 5 * 60 * 1000);
  const dueTime = `${String(fireTime.getHours()).padStart(2, '0')}:${String(fireTime.getMinutes()).padStart(2, '0')}`;

  const task = {
    id: 'reminder-task',
    title: 'Remind me',
    due,
    dueTime,
    completed: false,
    reminders: [{ id: 'r1', minutes: 0 }],
  };
  replaceEntities({ tasks: [task] }, getCursor());

  const first = dueReminders(now.getTime());
  assert.equal(first.length, 1);
  assert.equal(first[0]?.task.id, 'reminder-task');

  const key = reminderKey(task);
  markReminderFired(task.id, key);
  assert.equal(dueReminders(now.getTime()).length, 0);

  // A changed due date gets a new key, so it can fire again.
  const changed = { ...task, dueTime: '23:59' };
  assert.notEqual(reminderKey(changed), key);
});

test('completed tasks and far-past reminders are skipped', () => {
  const now = Date.now();
  const old = new Date(now - 48 * 60 * 60 * 1000);
  const due = [
    old.getFullYear(),
    String(old.getMonth() + 1).padStart(2, '0'),
    String(old.getDate()).padStart(2, '0'),
  ].join('-');
  replaceEntities({
    tasks: [
      { id: 'done-task', title: 'Done', due, dueTime: '10:00', completed: true, reminders: [{ minutes: 0 }] },
      { id: 'old-task', title: 'Old', due, dueTime: '10:00', completed: false, reminders: [{ minutes: 0 }] },
    ],
  }, getCursor());

  const due_list = dueReminders(now);
  assert.deepEqual(due_list, []);
});

test('attachment cleanup removes only old, unreferenced blobs', async () => {
  const referenced = new Uint8Array([1, 2, 3]);
  const orphan = new Uint8Array([4, 5, 6]);
  const { putBlob } = await import('../src/db/repository.ts');
  putBlob('kept-attachment', referenced, { name: 'kept.bin' });
  putBlob('orphan-attachment', orphan, { name: 'orphan.bin' });

  replaceEntities({
    tasks: [{
      id: 'attachment-task',
      title: 'Has a file',
      attachments: [{ id: 'kept-attachment', name: 'kept.bin' }],
    }],
  }, getCursor());

  // Age both rows past the guard.
  getDb().prepare("update blobs set updated_at = '2000-01-01T00:00:00.000Z'").run();

  await withServer(async (base) => {
    const res = await fetch(`${base}/api/blobs/cleanup?olderThanHours=1`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json() as { removed: number; keys: string[] };
    assert.equal(body.removed, 1);
    assert.deepEqual(body.keys, ['orphan-attachment']);

    const remaining = getDb().prepare('select key from blobs order by key').all() as { key: string }[];
    assert.deepEqual(remaining.map(r => r.key), ['kept-attachment']);
  });
});

test('cleanup rejects an invalid age', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/blobs/cleanup?olderThanHours=0`, { method: 'POST' });
    assert.equal(res.status, 400);
  });
});
