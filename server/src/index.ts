import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.ts';
import { healthRouter } from './routes/health.ts';
import { errorHandler } from './middleware/errorHandler.ts';
import { requireAuth } from './middleware/requireAuth.ts';

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

  if (serveApp) {
    // Production: the built app from frontend/dist.
    const dist = resolve(frontendRoot, 'dist');
    app.use(express.static(dist, { index: false }));
    app.use((_req, res) => res.sendFile(resolve(dist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
