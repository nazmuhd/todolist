import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
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
export function createApp(options: { serveApp?: boolean } = {}) {
  const serveApp = options.serveApp ?? true;
  const app = express();
  app.set('trust proxy', 1);

  app.use(helmet({
    // The service worker and the app are served from this same origin.
    contentSecurityPolicy: false,
  }));
  app.use(cors({
    origin: config.corsOrigins,
    credentials: true,
  }));

  // CSRF mitigation for cookie-authenticated API/auth requests: require same-origin
  // or an allowed Origin/Referer on state-changing methods. In production, reject
  // unsafe requests that provide neither (defense-in-depth alongside SameSite cookies).
  app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const allowed = new Set(config.corsOrigins);
    const host = req.headers.host ? `${req.protocol}://${req.headers.host}` : null;
    if (host) allowed.add(host);
    const origin = req.headers.origin;
    if (origin) {
      return allowed.has(origin) ? next() : res.status(403).json({ error: 'Forbidden origin' });
    }
    const referer = req.headers.referer;
    if (referer) {
      try { return allowed.has(new URL(referer).origin) ? next() : res.status(403).json({ error: 'Forbidden origin' }); }
      catch { return res.status(403).json({ error: 'Forbidden origin' }); }
    }
    if (config.isProduction) return res.status(403).json({ error: 'Forbidden origin' });
    return next();
  });
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

  app.use('/auth', authRouter);

  app.get('/info', (_req, res) => {
    res.json({ name: 'todoist-clone-server', version: 1 });
  });

  app.use('/health', healthRouter);

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
  const landing = resolve(frontendRoot, 'public/landing');
  app.get('/', (_req, res) => res.sendFile(resolve(landing, 'home.html')));
  app.get('/registration.html', (_req, res) => res.sendFile(resolve(landing, 'registration.html')));
  app.get('/login.html', (_req, res) => res.sendFile(resolve(landing, 'login.html')));
  app.get('/forgot-password.html', (_req, res) => res.sendFile(resolve(landing, 'forgot-password.html')));
  app.get('/reset-password', (_req, res) => res.sendFile(resolve(landing, 'reset-password.html')));
  app.get('/reset-password.html', (_req, res) => res.sendFile(resolve(landing, 'reset-password.html')));

  if (serveApp) {
    // Production: the built app from frontend/dist, served under /app/v1/.
    const dist = resolve(frontendRoot, 'dist');
    app.get('/app/v1/*', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
    app.use('/app/v1', express.static(dist, { index: false }));
    app.use((_req, res) => res.sendFile(resolve(dist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
