import { Router } from 'express';
import { config } from '../config.ts';

export const healthRouter = Router();

/** Liveness/readiness probe: also reports which services are configured. */
healthRouter.get('/', (_req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    services: {
      supabase: config.hasSupabase,
      database: config.hasDatabase,
      push: config.hasPush,
    },
  });
});
