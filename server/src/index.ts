import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.ts';
import { healthRouter } from './routes/health.ts';
import { errorHandler } from './middleware/errorHandler.ts';
import { requireAuth } from './middleware/requireAuth.ts';

/** Builds the express app (kept separate so tests can import it). */
export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({
    origin: config.corsOrigins,
    credentials: true,
  }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/', (_req, res) => {
    res.json({ name: 'todoist-clone-server', version: 1 });
  });

  app.use('/health', healthRouter);

  // Everything below this line needs a signed-in user.
  app.use('/api', requireAuth);

  app.use(errorHandler);
  return app;
}
