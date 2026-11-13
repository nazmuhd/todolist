import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { SqliteRateLimitStore } from './middleware/rateLimitStore.ts';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.ts';
import { healthRouter } from './routes/health.ts';
import { stateRouter } from './routes/state.ts';
import { docsRouter } from './routes/docs.ts';
import { blobsRouter } from './routes/blobs.ts';
import { syncRouter } from './routes/sync.ts';
import { pushRouter } from './routes/push.ts';
import { errorHandler } from './middleware/errorHandler.ts';
import session from 'express-session';
import passport from 'passport';
import authRouter from './routes/auth.ts';
import { getDb } from './db/index.ts';

class NativeSqliteSessionStore extends session.Store {
  private getStmt: any; private setStmt: any; private destroyStmt: any; private cleanupStmt: any;
  constructor() {
    super();
    const db = getDb();
    this.getStmt = db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expired > ?');
    this.setStmt = db.prepare(`INSERT INTO sessions (sid, sess, expired) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expired = excluded.expired`);
    this.destroyStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.cleanupStmt = db.prepare('DELETE FROM sessions WHERE expired <= ?');
    setInterval(() => this.cleanupStmt.run(Date.now()), 15 * 60 * 1000).unref();
  }
  get(sid: string, cb: (err: any, session?: any) => void) { try { const r: any = this.getStmt.get(sid, Date.now()); cb(null, r ? JSON.parse(r.sess) : null); } catch (e) { cb(e); } }
  set(sid: string, sess: any, cb: (err?: any) => void) { try { const exp = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 7*24*60*60*1000; this.setStmt.run(sid, JSON.stringify(sess), exp); cb(); } catch (e) { cb(e); } }
  destroy(sid: string, cb: (err?: any) => void) { try { this.destroyStmt.run(sid); cb(); } catch (e) { cb(e); } }
}

// The repository root: the app lives in frontend/.
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const frontendRoot = resolve(root, 'frontend');

/**
 * Builds the express app.
 *
 * `serveApp` is false in development, where Vite is mounted in middleware
 * mode instead and serves the app with hot reloading.
 */
export function createApp(options: { serveApp?: boolean; vite?: any } = {}) {
  const serveApp = options.serveApp ?? true;
  const vite = options.vite;
  const app = express();
  app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "base-uri": ["'self'"],
        "form-action": ["'self'"],
        "frame-ancestors": ["'none'"],
        "object-src": ["'none'"],
        "script-src": [
          "'self'",
          ...(config.isProduction ? [] : ["'unsafe-eval'", "ws:", "wss:", "http:", "https:"]),
        ],
        "style-src": [
          "'self'",
          "'unsafe-inline'",
        ],
        "font-src": ["'self'", "data:"],
        "img-src": ["'self'", "data:", "blob:", "https:"],
        "connect-src": [
          "'self'",
          ...(config.isProduction ? [] : ["ws:", "wss:", "http:", "https:"]),
        ],
        "worker-src": ["'self'", "blob:"],
        "manifest-src": ["'self'"],
      },
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  }));
  app.use(cors({
    origin: config.corsOrigins,
    credentials: true,
  }));

  // Blobs arrive as a raw body; mount this before the JSON parser so a
  // binary attachment is never interpreted as JSON.
  app.use('/api/blobs', express.raw({ type: () => true, limit: '25mb' }));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use(session({
    store: new NativeSqliteSessionStore(),
    secret: config.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.isProduction, maxAge: 7*24*60*60*1000 },
  }));
  app.use(passport.initialize());
  app.use(passport.session());

  // CSRF mitigation: same-origin/Origin/Referer checks plus a synchronizer token
  // for unsafe methods on cookie-authenticated API/auth requests.
  app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const allowed = new Set(config.corsOrigins);
    const host = req.headers.host ? `${req.protocol}://${req.headers.host}` : null;
    if (host) allowed.add(host);
    const origin = req.headers.origin;
    if (origin) {
      if (!allowed.has(origin)) return res.status(403).json({ error: 'Forbidden origin' });
    } else {
      const referer = req.headers.referer;
      if (referer) {
        try {
          if (!allowed.has(new URL(referer).origin)) return res.status(403).json({ error: 'Forbidden origin' });
        } catch {
          return res.status(403).json({ error: 'Forbidden origin' });
        }
      } else if (config.isProduction) {
        return res.status(403).json({ error: 'Forbidden origin' });
      }
    }

    // Synchronizer CSRF token (defense-in-depth). Token endpoint itself is safe (GET).
    const sessionToken = (req.session as any)?.csrfToken;
    const headerToken = req.get('x-csrf-token');
    if (!sessionToken || typeof headerToken !== 'string' || headerToken !== sessionToken) {
      return res.status(403).json({ error: 'Invalid CSRF token' });
    }
    return next();
  });

  app.use('/auth', authRouter);

  app.get('/info', (_req, res) => {
    res.json({ name: 'todoist-clone-server', version: 1 });
  });

  app.use('/health', healthRouter);

  // General API rate limiting (abuse control). Tests run many requests quickly.
  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: config.NODE_ENV === 'test' ? 10000 : 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please try again later.' },
    store: new SqliteRateLimitStore({ prefix: 'api:' }),
  });
  app.use('/api', apiLimiter);

  // All app data APIs require an authenticated session.
  const requireApiAuth = (req: any, res: any, next: any) => {
    if (req.isAuthenticated && req.isAuthenticated()) return next();
    return res.status(401).json({ error: 'Unauthorized' });
  };
  app.use('/api/sync', requireApiAuth, syncRouter);
  app.use('/api/state', requireApiAuth, stateRouter);
  app.use('/api/docs', requireApiAuth, docsRouter);
  app.use('/api/blobs', requireApiAuth, blobsRouter);
  app.use('/api/push', requireApiAuth, pushRouter);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

  // Landing pages at root.
  const landing = resolve(frontendRoot, serveApp ? 'dist/landing' : 'landing');
  const sendLanding = async (req: any, res: any, file: string) => {
    const filePath = resolve(landing, file);
    if (vite) {
      const fs = await import('node:fs/promises');
      let html = await fs.readFile(filePath, 'utf-8');
      html = await vite.transformIndexHtml(req.originalUrl, html);
      res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
      return;
    }
    res.sendFile(filePath);
  };
  app.get('/', (req, res, next) => void sendLanding(req, res, 'home.html').catch(next));
  app.get('/registration.html', (req, res, next) => void sendLanding(req, res, 'registration.html').catch(next));
  app.get('/login.html', (req, res, next) => void sendLanding(req, res, 'login.html').catch(next));
  app.get('/forgot-password.html', (req, res, next) => void sendLanding(req, res, 'forgot-password.html').catch(next));
  app.get('/reset-password', (req, res, next) => void sendLanding(req, res, 'reset-password.html').catch(next));
  app.get('/reset-password.html', (req, res, next) => void sendLanding(req, res, 'reset-password.html').catch(next));

  if (serveApp) {
    // Production: serve built assets/files and the SPA from frontend/dist.
    const dist = resolve(frontendRoot, 'dist');
    // Root-level assets referenced by landing and SPA (/assets/*, /images/*, /sw.js, etc.)
    app.use(express.static(dist, { index: false }));
    app.get('/app/v1', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
    app.get('/app/v1/*', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
    // Fallback for unknown root paths (preserves previous behavior).
    app.use((_req, res) => res.sendFile(resolve(dist, 'index.html')));
  } else if (vite) {
    // Development SPA: let Vite transform the HTML entry.
    const sendSpa = async (req: any, res: any, next: any) => {
      try {
        const fs = await import('node:fs/promises');
        let html = await fs.readFile(resolve(frontendRoot, 'index.html'), 'utf-8');
        html = await vite.transformIndexHtml(req.originalUrl, html);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
      } catch (e) {
        vite.ssrFixStacktrace?.(e as Error);
        next(e);
      }
    };
    app.get('/app/v1', sendSpa);
    app.get('/app/v1/*', sendSpa);
  }

  app.use(errorHandler);
  return app;
}
