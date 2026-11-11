import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';

const { createApp } = await import('../src/index.ts');
const { migrate } = await import('../src/db/migrate.ts');
await migrate();

const app = createApp({ serveApp: true });

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

test('GET /health reports ok and a live database', async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.json() as { ok: boolean; services: { database: boolean; push: boolean } };

    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.services.database, true);
    assert.equal(typeof body.services.push, 'boolean');
  });
});

test('unknown API routes return a JSON 404', async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/tasks`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not_found' });
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

test('unknown routes fall back to the app shell', async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/some/deep/link`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /id="app"/);
  });
});
