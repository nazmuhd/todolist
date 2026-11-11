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
import { errorHandler } from './middleware/errorHandler.ts';

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
  // Blobs arrive as a raw body; mount this before the JSON parser so a
  // binary attachment is never interpreted as JSON.
  app.use('/api/blobs', express.raw({ type: () => true, limit: '25mb' }));
  app.use(express.json({ limit: '10mb' }));

  app.get('/info', (_req, res) => {
    res.json({ name: 'todoist-clone-server', version: 1 });
  });

  app.use('/health', healthRouter);

  // The API. There is no auth yet: this is a single-user store.
  app.use('/api/sync', syncRouter);
  app.use('/api/state', stateRouter);
  app.use('/api/docs', docsRouter);
  app.use('/api/blobs', blobsRouter);
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
