import { Router } from 'express';
import {
  backupEntities,
  exportEntities,
  getCursor,
  replaceEntities,
  ENTITY_NAMES,
  type EntityName,
} from '../db/repository.ts';

/**
 * Whole-state compatibility endpoint.
 *
 * The app syncs per entity through `/api/sync`; this endpoint builds a
 * snapshot of those entities for exports, imports and simple API clients.
 */
export const stateRouter = Router();

stateRouter.get('/', (_req, res) => {
  res.json({ data: exportEntities(), rev: getCursor(), updatedAt: null });
});

stateRouter.put('/', (req, res) => {
  const body = req.body as { data?: unknown; baseRev?: unknown } | undefined;
  if (!body || !body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
    res.status(400).json({ error: 'invalid_state' });
    return;
  }
  if (body.baseRev !== undefined && (typeof body.baseRev !== 'number' || !Number.isInteger(body.baseRev) || body.baseRev < 0)) {
    res.status(400).json({ error: 'invalid_base_rev' });
    return;
  }

  const snapshot = body.data as Partial<Record<EntityName, unknown[]>>;
  for (const entity of ENTITY_NAMES) {
    if (snapshot[entity] !== undefined && !Array.isArray(snapshot[entity])) {
      res.status(400).json({ error: 'invalid_state', entity });
      return;
    }
  }

  const result = replaceEntities(snapshot, body.baseRev ?? 0);
  if (!result.ok) {
    res.status(409).json({ error: 'conflict', rev: result.cursor });
    return;
  }
  res.json({ rev: result.cursor, updatedAt: null });
});

stateRouter.post('/backup/:tag', (req, res) => {
  const tag = String(req.params.tag || 'backup');
  if (!backupEntities(tag)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.status(201).json({ ok: true, tag });
});
