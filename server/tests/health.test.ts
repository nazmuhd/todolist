import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/index.ts';

const app = createApp();

async function withServer(fn: (port: number) => Promise<void>) {
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    await fn(port);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test('GET /health reports ok', async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.json() as { ok: boolean; services: { supabase: boolean } };

    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(typeof body.services.supabase, 'boolean');
  });
});

test('protected routes reject anonymous callers', async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/tasks`);
    assert.equal(res.status, 401);
  });
});

test('the server serves the app shell', async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /id="app"/);
  });
});

test('the server serves the app modules and vendor files', async () => {
  await withServer(async (port) => {
    const app_js = await fetch(`http://127.0.0.1:${port}/app.js`);
    assert.equal(app_js.status, 200);
    assert.match(await app_js.text(), /src\/core\/dates\.js/);

    const dates = await fetch(`http://127.0.0.1:${port}/src/core/dates.js`);
    assert.equal(dates.status, 200);

    const vendor = await fetch(`http://127.0.0.1:${port}/vendor/lucide.min.js`);
    assert.equal(vendor.status, 200);
  });
});

test('unknown routes fall back to the app shell', async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/some/deep/link`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /id="app"/);
  });
});
