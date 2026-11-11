import { Router } from 'express';
import { getDb } from '../db/index.ts';
import { config } from '../config.ts';

export const healthRouter = Router();

/** Liveness/readiness probe: also reports which services are configured. */
healthRouter.get('/', (_req, res) => {
  let database = false;
  try {
    database = Boolean(getDb().prepare('select 1 as ok').get());
  } catch (err) {
    console.error('Database health check failed:', err);
  }
  res.json({
    ok: database,
    uptime: Math.round(process.uptime()),
    services: {
      database,
      push: config.hasPush,
    },
  });
});
