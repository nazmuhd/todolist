import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/index.ts';

const app = createApp();

test('GET /health reports ok', async () => {
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const res = await fetch(`http://127.0.0.1:${port}/health`);
  const body = await res.json() as { ok: boolean; services: { supabase: boolean } };

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(typeof body.services.supabase, 'boolean');

  await new Promise<void>(resolve => server.close(() => resolve()));
});

test('protected routes reject anonymous callers', async () => {
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const res = await fetch(`http://127.0.0.1:${port}/api/tasks`);

  assert.equal(res.status, 401);
  await new Promise<void>(resolve => server.close(() => resolve()));
});
