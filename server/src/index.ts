import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.ts';
import { healthRouter } from './routes/health.ts';
import { errorHandler } from './middleware/errorHandler.ts';
import { requireAuth } from './middleware/requireAuth.ts';

// The repository root: the app is served from here.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Builds the express app (kept separate so tests can import it). */
export function createApp() {
  const app = express();

  app.use(helmet({
    // The service worker and the app are served from this same origin.
    contentSecurityPolicy: false,
  }));
  app.use(cors({
    origin: config.corsOrigins,
    credentials: true,
  }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/info', (_req, res) => {
    res.json({ name: 'todoist-clone-server', version: 1 });
  });

  app.use('/health', healthRouter);

  // The API. Everything below /api needs a signed-in user.
  app.use('/api', requireAuth);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

  // ---- the static app, served from the same origin ----
  app.use('/vendor', express.static(resolve(root, 'vendor'), { maxAge: '1h' }));
  app.use('/src', express.static(resolve(root, 'src'), { maxAge: '1h' }));

  const files = [
    '/todoist.html',
    '/app.js',
    '/storage.js',
    '/styles.css',
    '/sw.js',
    '/manifest.webmanifest',
    '/icon.svg',
  ];
  for (const file of files) {
    app.get(file, (_req, res) => res.sendFile(resolve(root, file.slice(1))));
  }

  // Anything else is the app shell (deep links such as #/today?q=p1).
  app.use((_req, res) => res.sendFile(resolve(root, 'todoist.html')));

  app.use(errorHandler);
  return app;
}
