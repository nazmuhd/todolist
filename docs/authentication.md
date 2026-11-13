# Product Requirements Document (PRD): Local-First Authentication System

**Version:** 2.0  
**Package Manager:** `pnpm`  
**Target Stack:** Node.js (v22.5+ built-in `node:sqlite`), Express 5, Passport.js (`passport-local`), `argon2`, `resend`  
**Architecture Goal:** Zero-external-auth-SaaS, self-hosted, single-file persistent SQLite authentication supporting secure email/password registration, login, session management, and password recovery via Resend (with Google OAuth 2.0 deferred to Phase 2).

---

## 1. Executive Summary & Objectives

Build a self-contained, high-performance authentication module without relying on third-party managed authentication providers (e.g., Auth0, Clerk, Firebase).

* **Primary Objective (Phase 1):** Authenticate users via Email/Password and handle secure Forgot/Reset Password flows via Resend, storing all user records, credential hashes, reset tokens, and active HTTP sessions locally in SQLite using Node's native `node:sqlite` module.
* **Future Objective (Phase 2):** Seamlessly integrate Google OAuth 2.0 with account linking on top of the existing `users` schema.
* **Security Objective:** Enforce modern password hashing using **Argon2id** as the primary hashing algorithm (with `bcrypt` fallback/auto-upgrade), cryptographic SHA-256 token hashing for password resets, HTTP-only session cookies, and IP-based rate limiting.
* **Zero Native Addon Overhead:** Eliminate C++ SQLite compilation steps (`better-sqlite3`) by utilizing Node.js's built-in `DatabaseSync` API.

---

## 2. Core Technology Stack & Setup (`pnpm`)

| Component | Package / Built-in | Role & Responsibility |
| :--- | :--- | :--- |
| **Runtime & DB** | `node:sqlite` (Built-in) | Synchronous native SQLite driver (`DatabaseSync`) storing `users`, `password_resets`, and `sessions`. |
| **Web Framework** | `express` | HTTP routing and middleware pipeline. |
| **Auth Middleware** | `passport` & `passport-local` | Request authentication lifecycle, local credential validation, and session serialization (`req.user`). |
| **Primary Hashing** | `argon2` (`argon2id`) | Memory-hard password hashing for registrations and password resets. |
| **Legacy Hashing** | `bcrypt` | Verifies legacy/migrated passwords and transparently upgrades them to `argon2id` upon login. |
| **Email Delivery** | `resend` | Sends transactional password reset links using an API key stored in `.env`. |
| **Session Store** | `express-session` | Manages HTTP-only session cookies backed by a custom `node:sqlite` store adapter. |
| **Security** | `express-rate-limit` & `dotenv` | Brute-force mitigation and environment variable management. |

### Installation via `pnpm`

Initialize your project and install all required dependencies using `pnpm`:

```bash
pnpm init
pnpm add express express-session passport passport-local argon2 bcrypt resend express-rate-limit dotenv
```

*(Note: Ensure `"type": "module"` is set in your `package.json` to use ES module `import` syntax.)*

---

## 3. Environment Configuration (`.env`)

All secrets and API keys must be stored strictly in `.env` and excluded from version control (`.gitignore`).

```env
PORT=3000
NODE_ENV=development
SESSION_SECRET=replace_with_a_64_char_cryptographically_random_string
RESEND_API_KEY=re_your_actual_resend_api_key_here
EMAIL_FROM="Security <onboarding@resend.dev>"
BASE_URL=http://localhost:3000
```

---

## 4. Database Schema Design (`node:sqlite`)

Enable `PRAGMA journal_mode = WAL;` and `PRAGMA foreign_keys = ON;` on database initialization for concurrent read/write performance and relational integrity.

### Table 1: `users`
```sql
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT,
    first_name TEXT,
    last_name TEXT,
    avatar_url TEXT,
    password_hash TEXT,                     -- Nullable for Phase 2 Google OAuth users
    hash_algorithm TEXT DEFAULT 'argon2id', -- 'argon2id' | 'bcrypt'
    email_verified INTEGER DEFAULT 0,       -- 0 = false, 1 = true
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
```

`name` is stored as the combined display/full name (derived from `first_name`/`last_name` when provided) for compatibility with UI and auth responses. New registrations collect and persist `first_name`/`last_name`.

### Table 2: `password_resets`
```sql
CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL,               -- SHA-256 hash of the raw reset token
    expires_at TEXT NOT NULL,               -- ISO 8601 timestamp (1-hour validity)
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);
```

### Table 3: `sessions`
```sql
CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expired INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired);
```

---

## 5. Functional Requirements & API Specification

### Auth/session endpoints

| Method | Endpoint | Auth Required | Rate Limited | CSRF Required | Purpose |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `GET` | `/auth/csrf` | No (session-backed) | No | No | Ensures a session exists and returns a synchronizer CSRF token for subsequent unsafe requests. |
| `POST` | `/auth/register` | No | Yes (`/auth` limiter) | Yes | Validates input, accepts `firstName`/`lastName` (and legacy `name` fallback), hashes password with `argon2id`, creates user, and initializes session. |
| `POST` | `/auth/login` | No | Yes (`/auth` limiter) | Yes | Authenticates via `passport-local` (`argon2id` or `bcrypt` upgrade), regenerates session, and sets cookie. |
| `POST` | `/auth/forgot-password` | No | Yes (`/auth` limiter) | Yes | Generates a 32-byte token, stores its SHA-256 hash, and dispatches a branded reset email via Resend (HTML + plain text). |
| `POST` | `/auth/reset-password` | No | Yes (`/auth` limiter) | Yes | Validates token hash & expiration, updates password to `argon2id`, consumes the reset token, and invalidates active sessions. |
| `GET` | `/auth/me` | Yes | No (global `/api` limiter does not apply) | No | Returns current authenticated user profile (`id`, `email`, `name`, `first_name`, `last_name`, `avatar_url`, `email_verified`, `created_at`). |
| `PUT` | `/auth/profile` | Yes | No | Yes | Updates the authenticated user's profile name fields (`firstName`/`lastName`, with `name` fallback) and persists `first_name`, `last_name`, and combined `name` in the database. |
| `POST` | `/auth/change-password` | Yes | Yes (`/auth` limiter) | Yes | Verifies current password, updates password hash to `argon2id`, invalidates all sessions (including current), logs out/destroys session, clears cookie, and requires re-login. |
| `POST` | `/auth/logout` | Yes | No | Yes | Destroys session in SQLite and clears browser cookie. |

### CSRF, origin checks, and request protection
- `GET /auth/csrf` creates/returns a session-backed synchronizer token (`X-CSRF-Token`) stored in the server session.
- Unsafe methods (`POST`, `PUT`, `PATCH`, `DELETE`) require:
  - An allowed `Origin`/`Referer` when present (checked against configured allowed origins / host rules), and
  - A matching `X-CSRF-Token` header value equal to the session CSRF token.
- CSRF enforcement runs after session/passport middleware so the session token is available for validation.
- SPA and landing/reset flows fetch and attach CSRF tokens for unsafe auth/API requests.

### Validation and abuse controls
- Request bodies/params/queries for auth and API routes are validated with **Zod v4** schemas (with route-specific compatibility where tests/clients depend on existing behavior).
- Password policy for new/changed passwords: **8–200 characters** and must include **at least one letter and one number**.
- Rate limiting:
  - Dedicated `/auth` limiter for authentication-sensitive endpoints.
  - General `/api` limiter for API abuse control (in-memory store; suitable for single-instance deployments).

### Per-user data isolation
- Authenticated `/api/*` routes are scoped to the logged-in user (per-user sync/state/docs/blobs/push data isolation).

---

## 6. Reference Implementation Code

### `db.js` — Native SQLite Initialization
```javascript
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(path.join(__dirname, 'database.sqlite'));

// Enable WAL mode and foreign key constraints
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT,
      avatar_url TEXT,
      password_hash TEXT,
      hash_algorithm TEXT DEFAULT 'argon2id',
      email_verified INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

  CREATE TABLE IF NOT EXISTS password_resets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);

  CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expired INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired);
`);

export default db;
```

### `server.js` — Complete Authentication Server
```javascript
import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import argon2 from 'argon2';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import { Resend } from 'resend';
import db from './db.js';

if (!process.env.SESSION_SECRET || !process.env.RESEND_API_KEY) {
  console.error('FATAL: SESSION_SECRET and RESEND_API_KEY must be defined in .env');
  process.exit(1);
}

const resend = new Resend(process.env.RESEND_API_KEY);
const app = express();

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- CUSTOM NATIVE SQLITE SESSION STORE ---
class NativeSqliteSessionStore extends session.Store {
  constructor(database) {
    super();
    this.db = database;
    this.getStmt = this.db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expired > ?');
    this.setStmt = this.db.prepare(`
      INSERT INTO sessions (sid, sess, expired) VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expired = excluded.expired
    `);
    this.destroyStmt = this.db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.cleanupStmt = this.db.prepare('DELETE FROM sessions WHERE expired <= ?');

    // Periodically purge expired sessions every 15 minutes
    setInterval(() => this.cleanupStmt.run(Date.now()), 15 * 60 * 1000).unref();
  }

  get(sid, callback) {
    try {
      const row = this.getStmt.get(sid, Date.now());
      callback(null, row ? JSON.parse(row.sess) : null);
    } catch (err) {
      callback(err);
    }
  }

  set(sid, sessionData, callback) {
    try {
      const expired = sessionData.cookie?.expires
        ? new Date(sessionData.cookie.expires).getTime()
        : Date.now() + 7 * 24 * 60 * 60 * 1000;
      this.setStmt.run(sid, JSON.stringify(sessionData), expired);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  destroy(sid, callback) {
    try {
      this.destroyStmt.run(sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }
}

app.use(
  session({
    store: new NativeSqliteSessionStore(db),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  })
);

app.use(passport.initialize());
app.use(passport.session());

// --- RATE LIMITER ---
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { error: 'Too many authentication attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// --- PREPARED STATEMENTS ---
const findUserByEmailStmt = db.prepare('SELECT * FROM users WHERE email = ?');
const findUserByIdStmt = db.prepare('SELECT id, email, name, avatar_url, email_verified, created_at FROM users WHERE id = ?');
const insertUserStmt = db.prepare(`
  INSERT INTO users (email, name, password_hash, hash_algorithm, email_verified)
  VALUES (?, ?, ?, 'argon2id', 0)
`);
const updatePasswordStmt = db.prepare(`
  UPDATE users SET password_hash = ?, hash_algorithm = 'argon2id', updated_at = datetime('now') WHERE id = ?
`);

// --- PASSPORT STRATEGY ---
passport.use(
  new LocalStrategy({ usernameField: 'email', passwordField: 'password' }, async (email, password, done) => {
    try {
      const normalizedEmail = email.toLowerCase().trim();
      const user = findUserByEmailStmt.get(normalizedEmail);

      if (!user || !user.password_hash) {
        return done(null, false, { message: 'Invalid email or password.' });
      }

      let isValid = false;
      if (user.hash_algorithm === 'argon2id') {
        isValid = await argon2.verify(user.password_hash, password);
      } else if (user.hash_algorithm === 'bcrypt') {
        isValid = await bcrypt.compare(password, user.password_hash);
        if (isValid) {
          const upgradedHash = await argon2.hash(password, {
            type: argon2.argon2id,
            memoryCost: 65536,
            timeCost: 3,
            parallelism: 4,
          });
          updatePasswordStmt.run(upgradedHash, user.id);
        }
      }

      if (!isValid) {
        return done(null, false, { message: 'Invalid email or password.' });
      }

      return done(null, user);
    } catch (err) {
      return done(err);
    }
  })
);

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  try {
    const user = findUserByIdStmt.get(id);
    done(null, user || false);
  } catch (err) {
    done(err);
  }
});

// --- ROUTES ---

// 1. Register
app.post('/auth/register', authLimiter, async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }
    if (!password || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    if (findUserByEmailStmt.get(normalizedEmail)) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    });

    const result = insertUserStmt.run(normalizedEmail, name?.trim() || null, passwordHash);
    const newUser = {
      id: Number(result.lastInsertRowid),
      email: normalizedEmail,
      name: name?.trim() || null,
      avatar_url: null,
      email_verified: 0,
    };

    req.login(newUser, (err) => {
      if (err) return res.status(500).json({ error: 'Account created, but automatic login failed.' });
      return res.status(201).json({ message: 'Registration successful.', user: newUser });
    });
  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// 2. Login
app.post('/auth/login', authLimiter, (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) return next(err);
    if (!user) return res.status(401).json({ error: info?.message || 'Invalid email or password.' });

    // Regenerate session ID on login to prevent session fixation attacks
    req.session.regenerate((regenErr) => {
      if (regenErr) return next(regenErr);
      req.login(user, (loginErr) => {
        if (loginErr) return next(loginErr);
        return res.json({
          message: 'Logged in successfully.',
          user: { id: user.id, email: user.email, name: user.name, avatar_url: user.avatar_url },
        });
      });
    });
  })(req, res, next);
});

// 3. Forgot Password (Resend Integration)
app.post('/auth/forgot-password', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required.' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const user = findUserByEmailStmt.get(normalizedEmail);

    // Always return identical 200 response to prevent user enumeration
    const genericResponse = { message: 'If an account with that email exists, a password reset link has been sent.' };
    if (!user) {
      return res.json(genericResponse);
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
    db.prepare('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)').run(
      user.id,
      tokenHash,
      expiresAt
    );

    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const resetLink = `${baseUrl}/reset-password?token=${rawToken}&email=${encodeURIComponent(user.email)}`;

    const { error } = await resend.emails.send({
      from: process.env.EMAIL_FROM || 'Security <onboarding@resend.dev>',
      to: user.email,
      subject: 'Reset Your Password',
      html: `
        <p>We received a request to reset your password.</p>
        <p><a href="${resetLink}">Click here to reset your password</a></p>
        <p>This link will expire in 1 hour. If you did not request this, you can safely ignore this email.</p>
      `,
    });

    if (error) {
      console.error('Resend API error:', error);
      return res.status(502).json({ error: 'Unable to send reset email at this time.' });
    }

    return res.json(genericResponse);
  } catch (err) {
    console.error('Forgot password error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// 4. Reset Password
app.post('/auth/reset-password', authLimiter, async (req, res) => {
  try {
    const { token, email, password } = req.body;
    if (!token || !email || !password || password.length < 8) {
      return res.status(400).json({ error: 'Valid token, email, and a password of at least 8 characters are required.' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const user = findUserByEmailStmt.get(normalizedEmail);
    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired password reset token.' });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const resetRecord = db
      .prepare('SELECT * FROM password_resets WHERE user_id = ? AND token_hash = ?')
      .get(user.id, tokenHash);

    if (!resetRecord || new Date(resetRecord.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Invalid or expired password reset token.' });
    }

    const newPasswordHash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    });

    // Atomic update of password and cleanup of reset token
    db.exec('BEGIN IMMEDIATE');
    try {
      updatePasswordStmt.run(newPasswordHash, user.id);
      db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
      db.exec('COMMIT');
    } catch (txErr) {
      db.exec('ROLLBACK');
      throw txErr;
    }

    return res.json({ message: 'Password has been reset successfully. You may now log in.' });
  } catch (err) {
    console.error('Reset password error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// 5. Get Current User
app.get('/auth/me', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.json({ user: req.user });
});

// 6. Logout
app.post('/auth/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy((destroyErr) => {
      if (destroyErr) return res.status(500).json({ error: 'Failed to destroy session.' });
      res.clearCookie('connect.sid');
      return res.json({ message: 'Logged out successfully.' });
    });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Auth server running on http://localhost:${PORT} using node:sqlite`);
});
```

---

## 7. Current Implementation Notes (Repository)

- **Auth integration:** The app integrates auth into the main server (`server/src/index.ts`, `server/src/routes/auth.ts`, `server/src/db/*`) using `node:sqlite` migrations and session-backed authentication, rather than the standalone `server.js`/`db.js` sample shown above.
- **Registration/profile:** Registration collects **first name** and **last name** and stores `first_name`, `last_name`, and combined `name`. `GET /auth/me` returns profile name fields, and `PUT /auth/profile` persists profile name updates to the database.
- **UI:** The frontend includes authenticated landing/auth pages and app-side profile settings. Password changes are handled in a separate **Security** modal (moved out of Profile settings) and call `POST /auth/change-password`.
- **Password reset email:** Forgot-password sends a branded HTML + plain-text email via Resend. The template includes a centered inline CID logo (loaded from `frontend/public/images/logo.png` when available, with URL fallback), personalized greeting, CTA/reset link, expiry/security messaging, and fallback link text.
- **Session invalidation:** Password reset invalidates existing sessions. Password change updates credentials, invalidates **all** user sessions (including current), logs out/destroys the current session, clears the auth cookie, and requires the user to log in again.
- **CSRF/origin enforcement:** Unsafe requests require a valid session-backed `X-CSRF-Token` and pass origin/referer checks (when present). SPA/landing/reset flows fetch and send CSRF tokens.
- **Security headers/CSP:** Helmet is enabled with CSP and additional response headers (including `Referrer-Policy`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`). CSP currently allows required external assets/scripts/styles for the existing frontend (Tailwind CDN, jsDelivr, Google Fonts) and `style-src 'unsafe-inline'`; tightening/removing these dependencies remains a follow-up hardening task.
- **SQLite hardening:** Database initialization enables WAL, foreign keys, busy timeout, and `synchronous=NORMAL`; best-effort restrictive file/directory permissions are applied for non-memory databases.
- **Error handling:** Client-facing 5xx responses are sanitized to avoid leaking internal error details; server-side logging retains diagnostics.
- **Dependency posture:** Server dependencies have been updated to remediate prior audit findings (including Zod v4 migration for validation code paths). Continue periodic `pnpm audit` and dependency maintenance.

## 8. Security & Acceptance Criteria

1. **Zero Native Compilation:** Running `pnpm install` and starting the server works on Node.js with built-in `node:sqlite` (no `better-sqlite3`/`node-gyp` dependency).
2. **Session Fixation Mitigation:** Login/registration flows regenerate session identifiers before establishing authenticated sessions.
3. **CSRF + Origin Defense (Defense in Depth):** Unsafe requests are protected by origin/referer checks and a session-backed synchronizer CSRF token (`X-CSRF-Token`) issued via `GET /auth/csrf`.
4. **Cryptographic Reset Tokens:** Raw reset tokens are never stored in plaintext; only SHA-256 hashes are persisted with expiration checks and transactional cleanup on use.
5. **Session Invalidation on Credential Recovery/Change:** Password reset and password change invalidate sessions; password change requires re-authentication (logout + redirect to login in the UI flow).
6. **Password Policy & Hashing:** New/changed passwords require 8–200 chars with at least one letter and one number; passwords are stored as Argon2id hashes (with bcrypt verification/upgrade path for legacy hashes).
7. **Validation & Abuse Controls:** Auth/API inputs are schema-validated (Zod v4), auth endpoints are rate-limited, and a general `/api` rate limiter provides baseline abuse protection (in-memory; shared/distributed store recommended for multi-instance deployments).
8. **CSP/Security Headers:** Helmet CSP and additional security headers are enabled. Current CSP still permits `'unsafe-inline'` styles and required external frontend assets/CDNs; further tightening is a planned hardening step.
9. **Phase 2 Readiness (Google OAuth):** Nullable `password_hash` and existing profile/verification fields keep the schema compatible with future OAuth account-linking additions.

## 9. Verification Status & Remaining Hardening Tasks

- **Automated verification:** Server test suite passes (including auth/CSRF/sync coverage) and dependency audit is clean at the time of the latest remediation commits.
- **Smoke verification (non-browser):** CSRF endpoint issuance and key response security headers (CSP, Referrer-Policy, COOP, CORP) were verified via local app smoke checks.
- **Pending manual/browser verification:** Full SPA and landing/reset/auth flow verification under CSP+CSRF in a browser (console/network/CSP violation checks, login/register/forgot/reset/logout/profile/password change/sync) is still recommended.
- **Remaining hardening work:**
  - Comprehensive SPA XSS sink audit/refactor for remaining untrusted render paths.
  - CSP tightening (reduce/remove `style-src 'unsafe-inline'` and external CDN reliance where practical).
  - Shared rate-limit store/tuning for multi-instance deployments.
  - Continued request validation centralization and auth/session edge-case review.