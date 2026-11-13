import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcrypt';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 4569;
const BASE = `http://127.0.0.1:${PORT}`;
let child: ChildProcess | undefined;
let dbDir: string | undefined;
let dbPath: string | undefined;

async function waitReady(base: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/auth/health`);
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`auth server did not start on ${base}`);
}

function cookieJar(res: Response): string {
  const raw = (res.headers as any).getSetCookie?.() ?? [res.headers.get('set-cookie')];
  return (raw as string[]).filter(Boolean).map(c => c.split(';')[0]).join('; ');
}
function mergeCookies(a?: string, b?: string) {
  const map = new Map<string,string>();
  for (const part of [a,b].filter(Boolean).join('; ').split(';')) {
    const p = part.trim(); if (!p) continue; const i = p.indexOf('='); if (i<0) continue; map.set(p.slice(0,i), p.slice(i+1));
  }
  return [...map.entries()].map(([k,v])=>`${k}=${v}`).join('; ');
}
async function csrf(cookies?: string) {
  const res = await fetch(`${BASE}/auth/csrf`, { headers: cookies ? { cookie: cookies } : {} });
  const set = cookieJar(res);
  const jar = mergeCookies(cookies, set);
  let data: any = null;
  try { data = await res.json(); } catch {}
  return { token: data?.csrfToken as string | undefined, cookies: jar };
}
async function call(method: string, path: string, body?: unknown, cookies?: string) {
  let jar = cookies || '';
  let token: string | undefined;
  if (!['GET','HEAD','OPTIONS'].includes(method.toUpperCase())) {
    const c = await csrf(jar || undefined);
    token = c.token;
    jar = c.cookies;
  }
  const headers: Record<string,string> = { 'content-type': 'application/json' };
  if (jar) headers.cookie = jar;
  if (token) headers['x-csrf-token'] = token;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data: any = null;
  try { data = await res.json(); } catch {}
  const set = cookieJar(res);
  return { status: res.status, data, cookies: mergeCookies(jar, set) };
}

before(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'auth-test-'));
  dbPath = join(dbDir, 'auth.sqlite');

  // Pre-seed a legacy bcrypt user for migration testing.
  const seedDb = new DatabaseSync(dbPath);
  seedDb.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT,
      first_name TEXT,
      last_name TEXT,
      avatar_url TEXT,
      password_hash TEXT,
      hash_algorithm TEXT DEFAULT 'argon2id',
      email_verified INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  const legacyHash = bcrypt.hashSync('legacypass123', 10);
  seedDb.prepare(
    "INSERT INTO users (email, name, password_hash, hash_algorithm, email_verified) VALUES (?, ?, ?, 'bcrypt', 1)",
  ).run('legacy@domain.com', 'Legacy User', legacyHash);
  seedDb.close();

  child = spawn(process.execPath, ['--experimental-strip-types', join(here, '..', 'src', 'server.ts')], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(PORT),
      DATABASE_PATH: dbPath,
      QUIET_HOURS_START: '23:00',
      QUIET_HOURS_END: '07:00',
      EMAIL_DRY_RUN: '1',
      AUTH_RATE_MAX: '100',
      SESSION_SECRET: 'test-secret-please-change-me-1234',
      BASE_URL: BASE,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr?.on('data', d => process.stderr.write(d));
  await waitReady(BASE);
});

after(() => {
  child?.kill('SIGKILL');
  try { if (dbDir) rmSync(dbDir, { recursive: true, force: true }); } catch {}
});

test('registration enforces strict input sanitization and boundary constraints', async () => {
  const emptyBody = await call('POST', '/auth/register', {});
  assert.equal(emptyBody.status, 400);

  const missingEmail = await call('POST', '/auth/register', { password: 'securepassword123' });
  assert.equal(missingEmail.status, 400);

  const malformedEmail = await call('POST', '/auth/register', { email: 'not-an-email-address', password: 'securepassword123' });
  assert.equal(malformedEmail.status, 400);

  const shortPass = await call('POST', '/auth/register', { email: 'short@domain.com', password: 'short' });
  assert.equal(shortPass.status, 400);

  const ok = await call('POST', '/auth/register', { email: 'user@domain.com', name: 'Test User', password: 'securepassword123' });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.user.email, 'user@domain.com');
  assert.ok(ok.cookies.includes('connect.sid='));

  const dup = await call('POST', '/auth/register', { email: 'USER@domain.com', password: 'securepassword123' });
  assert.equal(dup.status, 409);
});

test('login verifies legacy bcrypt hashes and transparently upgrades them to argon2id', async () => {
  const standardLogin = await call('POST', '/auth/login', { email: 'user@domain.com', password: 'securepassword123' });
  assert.equal(standardLogin.status, 200);

  const legacyLogin = await call('POST', '/auth/login', { email: 'legacy@domain.com', password: 'legacypass123' });
  assert.equal(legacyLogin.status, 200);
  assert.equal(legacyLogin.data.user.email, 'legacy@domain.com');

  const checkDb = new DatabaseSync(dbPath!);
  const row = checkDb.prepare('SELECT hash_algorithm, password_hash FROM users WHERE email = ?').get('legacy@domain.com') as any;
  checkDb.close();
  assert.equal(row.hash_algorithm, 'argon2id');
  assert.ok(row.password_hash.startsWith('$argon2id$'));
});

test('login rejects invalid credentials', async () => {
  const bad = await call('POST', '/auth/login', { email: 'user@domain.com', password: 'wrongpassword' });
  assert.equal(bad.status, 401);
});

test('/auth/me requires a valid session cookie', async () => {
  const anon = await call('GET', '/auth/me');
  assert.equal(anon.status, 401);

  const login = await call('POST', '/auth/login', { email: 'user@domain.com', password: 'securepassword123' });
  const me = await call('GET', '/auth/me', undefined, login.cookies);
  assert.equal(me.status, 200);
  assert.equal(me.data.user.email, 'user@domain.com');
});

test('forgot-password prevents enumeration and reset-password handles security checks', async () => {
  const missing = await call('POST', '/auth/forgot-password', { email: 'ghost-account@domain.com' });
  assert.equal(missing.status, 200);
  assert.match(missing.data.message, /if an account/i);

  const sessionBeforeReset = await call('POST', '/auth/login', { email: 'user@domain.com', password: 'securepassword123' });
  assert.equal(sessionBeforeReset.status, 200);

  const forgot = await call('POST', '/auth/forgot-password', { email: 'user@domain.com' });
  assert.equal(forgot.status, 200);
  assert.ok(forgot.data.dev_reset_link);

  const token = new URL(forgot.data.dev_reset_link).searchParams.get('token');

  const fakeReset = await call('POST', '/auth/reset-password', { email: 'user@domain.com', token: 'invalid_fake_token_string', password: 'brandnewpassword999' });
  assert.equal(fakeReset.status, 400);

  const reset = await call('POST', '/auth/reset-password', { email: 'user@domain.com', token, password: 'brandnewpassword999' });
  assert.equal(reset.status, 200);

  const oldSessionMe = await call('GET', '/auth/me', undefined, sessionBeforeReset.cookies);
  assert.equal(oldSessionMe.status, 401, 'password reset must invalidate existing sessions');

  const reuseReset = await call('POST', '/auth/reset-password', { email: 'user@domain.com', token, password: 'anotherpassword123' });
  assert.equal(reuseReset.status, 400);

  const oldLogin = await call('POST', '/auth/login', { email: 'user@domain.com', password: 'securepassword123' });
  assert.equal(oldLogin.status, 401);

  const newLogin = await call('POST', '/auth/login', { email: 'user@domain.com', password: 'brandnewpassword999' });
  assert.equal(newLogin.status, 200);
});

test('logout destroys session and invalidates cookie', async () => {
  const login = await call('POST', '/auth/login', { email: 'user@domain.com', password: 'brandnewpassword999' });
  assert.equal(login.status, 200);

  const out = await call('POST', '/auth/logout', {}, login.cookies);
  assert.equal(out.status, 200);

  const me = await call('GET', '/auth/me', undefined, login.cookies);
  assert.equal(me.status, 401);
});

test('change-password requires auth, validates input, and rotates password', async () => {
  const unauth = await call('POST', '/auth/change-password', { currentPassword: 'brandnewpassword999', newPassword: 'anothernewpass1' });
  assert.equal(unauth.status, 401);

  const login = await call('POST', '/auth/login', { email: 'user@domain.com', password: 'brandnewpassword999' });
  assert.equal(login.status, 200);

  const missing = await call('POST', '/auth/change-password', { newPassword: 'anothernewpass1' }, login.cookies);
  assert.equal(missing.status, 400);

  const short = await call('POST', '/auth/change-password', { currentPassword: 'brandnewpassword999', newPassword: 'short' }, login.cookies);
  assert.equal(short.status, 400);

  const wrong = await call('POST', '/auth/change-password', { currentPassword: 'wrongcurrent1', newPassword: 'anothernewpass1' }, login.cookies);
  assert.equal(wrong.status, 401);

  const ok = await call('POST', '/auth/change-password', { currentPassword: 'brandnewpassword999', newPassword: 'anothernewpass1' }, login.cookies);
  assert.equal(ok.status, 200);

  const oldLogin = await call('POST', '/auth/login', { email: 'user@domain.com', password: 'brandnewpassword999' });
  assert.equal(oldLogin.status, 401);
  const newLogin = await call('POST', '/auth/login', { email: 'user@domain.com', password: 'anothernewpass1' });
  assert.equal(newLogin.status, 200);
});

test('rate limiter blocks excessive authentication requests', async () => {
  // A dedicated instance with a tiny limit keeps the shared suite unaffected.
  const limitPort = 4570;
  const limitBase = `http://127.0.0.1:${limitPort}`;
  const limitDir = mkdtempSync(join(tmpdir(), 'auth-rate-'));
  const limitChild = spawn(process.execPath, ['--experimental-strip-types', join(here, '..', 'src', 'server.ts')], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(limitPort),
      DATABASE_PATH: join(limitDir, 'todoist.db'),
      QUIET_HOURS_START: '23:00',
      QUIET_HOURS_END: '07:00',
      EMAIL_DRY_RUN: '1',
      AUTH_RATE_MAX: '3',
      SESSION_SECRET: 'test-secret-please-change-me-1234',
      BASE_URL: limitBase,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitReady(limitBase);
    let sawLimit = false;
    let jar = '';
    for (let i = 0; i < 8; i++) {
      const cr = await fetch(`${limitBase}/auth/csrf`, { headers: jar ? { cookie: jar } : {} });
      const set = cookieJar(cr); if (set) jar = [jar,set].filter(Boolean).join('; ');
      const cd = await cr.json().catch(() => ({} as any));
      const token = (cd as any).csrfToken;
      const res = await fetch(`${limitBase}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(jar ? { cookie: jar } : {}), ...(token ? { 'x-csrf-token': token } : {}) },
        body: JSON.stringify({ email: 'x@domain.com', password: 'wrongpassword' }),
      });
      const s2 = cookieJar(res); if (s2) jar = [jar,s2].filter(Boolean).join('; ');
      if (res.status === 429) { sawLimit = true; break; }
    }
    assert.equal(sawLimit, true, 'Rate limiter should return 429 after threshold');
  } finally {
    limitChild.kill('SIGKILL');
    try { rmSync(limitDir, { recursive: true, force: true }); } catch {}
  }
});
