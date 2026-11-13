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
const { getDb } = await import('../src/db/index.ts');
const { replaceEntities, markReminderFired, getCursor, listPushDevices, putBlob } = await import('../src/db/repository.ts');
const { dueRemindersForUser, reminderKey, taskReminderList, reminderAt, zonedDateTimeToDate, inQuietHours } = await import('../src/services/reminders.ts');
const { pushRetryable, subscriptionGone } = await import('../src/services/push.ts');
await migrate();

const db = getDb();
const u = db.prepare("INSERT INTO users (email,name,password_hash,hash_algorithm) VALUES ('push@test.com','P','x','argon2id')").run();
const USER_ID = Number(u.lastInsertRowid);

const app = createApp({ serveApp: false });

async function withServer(fn: (base: string, cookie: string) => Promise<void>) {
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  try {
    let res = await fetch(`${base}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'push-http@test.com', password: 'password123', name: 'PH' }) });
    if (res.status === 409) res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'push-http@test.com', password: 'password123' }) });
    const cookie = (res.headers.getSetCookie?.() || [res.headers.get('set-cookie')]).filter(Boolean).map(c => c!.split(';')[0]).join('; ');
    await fn(base, cookie);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('push endpoints are explicit when VAPID is not configured', async () => {
  await withServer(async (base, cookie) => {
    let res = await fetch(`${base}/api/push/key`, { headers: { cookie } });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'push_disabled' });
    res = await fetch(`${base}/api/push/test`, { method: 'POST', headers: { cookie } });
    assert.equal(res.status, 404);
  });
});

test('subscriptions validate, store and delete', async () => {
  await withServer(async (base, cookie) => {
    let res = await fetch(`${base}/api/push/subscribe`, { ...json('POST', { endpoint: 'nope' }), headers: { 'content-type': 'application/json', cookie } });
    assert.equal(res.status, 400);

    const subscription = { endpoint: 'https://push.example.test/abc', keys: { p256dh: 'key', auth: 'secret' }, label: 'Chrome on Windows', userAgent: 'Mozilla/5.0 test' };
    res = await fetch(`${base}/api/push/subscribe`, { ...json('POST', subscription), headers: { 'content-type': 'application/json', cookie } });
    assert.equal(res.status, 201);

    const httpUser = (db.prepare("SELECT id FROM users WHERE email='push-http@test.com'").get() as any).id as number;
    const devices = listPushDevices(httpUser);
    assert.equal(devices.length, 1);
    assert.equal(devices[0]?.label, 'Chrome on Windows');
    assert.equal(devices[0]?.userAgent, 'Mozilla/5.0 test');
    assert.ok(devices[0]?.lastSeenAt);

    res = await fetch(`${base}/api/push/subscriptions`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const publicDevices = await res.json() as { subscriptions: Record<string, unknown>[] };
    assert.equal(publicDevices.subscriptions.length, 1);
    assert.equal(publicDevices.subscriptions[0]?.label, 'Chrome on Windows');
    assert.equal(publicDevices.subscriptions[0]?.p256dh, undefined);
    assert.equal(publicDevices.subscriptions[0]?.auth, undefined);

    res = await fetch(`${base}/api/push/subscribe`, { method: 'DELETE', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ endpoint: subscription.endpoint }) });
    assert.equal(res.status, 204);

    res = await fetch(`${base}/api/push/subscribe`, { method: 'DELETE', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ endpoint: subscription.endpoint }) });
    assert.equal(res.status, 404);
  });
});

test('due reminders are computed once and recorded', () => {
  const now = new Date();
  const due = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  const fireTime = new Date(now.getTime() - 5 * 60 * 1000);
  const dueTime = `${String(fireTime.getHours()).padStart(2, '0')}:${String(fireTime.getMinutes()).padStart(2, '0')}`;
  const task = { id: 'reminder-task', title: 'Remind me', due, dueTime, completed: false, reminders: [{ id: 'r1', minutes: 0 }] };
  replaceEntities(USER_ID, { tasks: [task] }, getCursor(USER_ID));

  const first = dueRemindersForUser(USER_ID, now.getTime());
  assert.equal(first.length, 1);
  assert.equal(first[0]?.task.id, 'reminder-task');

  const key = reminderKey(task);
  markReminderFired(USER_ID, task.id, key);
  assert.equal(dueRemindersForUser(USER_ID, now.getTime()).length, 0);

  const changed = { ...task, dueTime: '23:59' };
  assert.notEqual(reminderKey(changed), key);
});

test('completed tasks and far-past reminders are skipped', () => {
  const now = Date.now();
  const old = new Date(now - 48 * 60 * 60 * 1000);
  const due = [old.getFullYear(), String(old.getMonth() + 1).padStart(2, '0'), String(old.getDate()).padStart(2, '0')].join('-');
  replaceEntities(USER_ID, { tasks: [
    { id: 'done-task', title: 'Done', due, dueTime: '10:00', completed: true, reminders: [{ minutes: 0 }] },
    { id: 'old-task', title: 'Old', due, dueTime: '10:00', completed: false, reminders: [{ minutes: 0 }] },
  ] }, getCursor(USER_ID));
  const due_list = dueRemindersForUser(USER_ID, now);
  assert.deepEqual(due_list, []);
});

test('attachment cleanup removes only old, unreferenced blobs', async () => {
  await withServer(async (base, cookie) => {
    const httpUser = (db.prepare("SELECT id FROM users WHERE email='push-http@test.com'").get() as any).id as number;
    putBlob(httpUser, 'kept-attachment', new Uint8Array([1, 2, 3]), { name: 'kept.bin' });
    putBlob(httpUser, 'orphan-attachment', new Uint8Array([4, 5, 6]), { name: 'orphan.bin' });
    replaceEntities(httpUser, { tasks: [{ id: 'attachment-task', title: 'Has a file', attachments: [{ id: 'kept-attachment', name: 'kept.bin' }] }] }, getCursor(httpUser));
    db.prepare("update blobs set updated_at = '2000-01-01T00:00:00.000Z' where user_id = ?").run(httpUser);

    const res = await fetch(`${base}/api/blobs/cleanup?olderThanHours=1`, { method: 'POST', headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json() as { removed: number; keys: string[] };
    assert.equal(body.removed, 1);
    assert.deepEqual(body.keys, ['orphan-attachment']);

    const remaining = db.prepare('select key from blobs where user_id = ? order by key').all(httpUser) as { key: string }[];
    assert.deepEqual(remaining.map(r => r.key), ['kept-attachment']);
  });
});

test('cleanup rejects an invalid age', async () => {
  await withServer(async (base, cookie) => {
    const res = await fetch(`${base}/api/blobs/cleanup?olderThanHours=0`, { method: 'POST', headers: { cookie } });
    assert.equal(res.status, 400);
  });
});

function localDateTimeMinutesAgo(minutesAgo: number): string {
  const d = new Date(Date.now() - minutesAgo * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

test('absolute reminders fire without a due date', () => {
  const at = localDateTimeMinutesAgo(5);
  const task = { id: 'absolute-reminder', title: 'Absolute', due: null, completed: false, reminders: [{ id: 'r1', at }] };
  replaceEntities(USER_ID, { tasks: [task] }, getCursor(USER_ID));
  const due_list = dueRemindersForUser(USER_ID, Date.now());
  assert.equal(due_list.length, 1);
  assert.equal(due_list[0]?.task.id, 'absolute-reminder');
  assert.equal(reminderKey(task), `|||at:${at}`);
  assert.notEqual(reminderKey({ ...task, reminders: [{ id: 'r1', at: localDateTimeMinutesAgo(1) }] }), reminderKey(task));
});

test('relative and absolute reminders normalize into one list', () => {
  assert.deepEqual(taskReminderList({ id: 'x', title: 'x', reminders: [{ id: 'a', minutes: 30 }, { id: 'b', at: '2026-11-12T09:00' }, { id: 'c' }] }), [{ id: 'a', minutes: 30 }, { id: 'b', at: '2026-11-12T09:00' }]);
  assert.deepEqual(taskReminderList({ id: 'x', title: 'x', reminders: [], reminderMinutes: 10 }), [{ minutes: 10 }]);
});

test('wall-clock times convert using the task timezone', () => {
  assert.equal(zonedDateTimeToDate('2026-01-15T09:00', 'America/New_York')?.toISOString(), '2026-01-15T14:00:00.000Z');
  assert.equal(zonedDateTimeToDate('2026-07-15T09:00', 'America/New_York')?.toISOString(), '2026-07-15T13:00:00.000Z');
  const task = { id: 'tz', title: 'TZ', due: '2026-11-12', dueTime: '09:00', timeZone: 'Asia/Tokyo' };
  assert.equal(reminderAt(task, { minutes: 0 })?.toISOString(), '2026-11-12T00:00:00.000Z');
});

test('quiet hours suppress delivery and handle overnight windows', () => {
  const at = (h: number, m = 0) => new Date(2026, 0, 5, h, m);
  assert.equal(inQuietHours(at(23), '22:00', '07:00'), true);
  assert.equal(inQuietHours(at(6, 59), '22:00', '07:00'), true);
  assert.equal(inQuietHours(at(7), '22:00', '07:00'), false);
  assert.equal(inQuietHours(at(13), '09:00', '17:00'), true);
  assert.equal(inQuietHours(at(18), '09:00', '17:00'), false);
  assert.equal(inQuietHours(at(13), '09:00', '09:00'), false);
  assert.equal(inQuietHours(at(13), null, null), false);

  const now = new Date();
  const due = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const past = new Date(now.getTime() - 5 * 60 * 1000);
  const dueTime = `${String(past.getHours()).padStart(2, '0')}:${String(past.getMinutes()).padStart(2, '0')}`;
  replaceEntities(USER_ID, { tasks: [{ id: 'quiet-task', title: 'Quiet', due, dueTime, completed: false, reminders: [{ id: 'r', minutes: 0 }] }] }, getCursor(USER_ID));
  const allDay = { start: '00:00', end: '23:59' };
  assert.deepEqual(dueRemindersForUser(USER_ID, now.getTime(), allDay), []);
});

test('push retry classification covers transient and permanent failures', () => {
  assert.equal(subscriptionGone(404), true);
  assert.equal(subscriptionGone(410), true);
  assert.equal(subscriptionGone(500), false);
  assert.equal(pushRetryable(undefined), true);
  assert.equal(pushRetryable(429), true);
  assert.equal(pushRetryable(503), true);
  assert.equal(pushRetryable(400), false);
  assert.equal(pushRetryable(401), false);
});
