import { Router } from 'express';
import { applyChanges, changesSince, ENTITY_NAMES, type EntityChange, type EntityName } from '../db/repository.ts';
import { runBackup } from '../services/backups.ts';

export const syncRouter = Router();

syncRouter.get('/', (req, res) => {
  const since = Number(req.query.since ?? 0);
  if (!Number.isInteger(since) || since < 0) {
    res.status(400).json({ error: 'invalid_since' });
    return;
  }

  // `limit` is optional: without it the whole feed comes back (compatibility).
  const rawLimit = req.query.limit;
  let limit: number | undefined;
  if (rawLimit !== undefined) {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      res.status(400).json({ error: 'invalid_limit' });
      return;
    }
  }

  res.json(changesSince(since, limit));
});

syncRouter.post('/', (req, res) => {
  const body = req.body as { changes?: unknown } | undefined;
  if (!body || !body.changes || typeof body.changes !== 'object') {
    res.status(400).json({ error: 'invalid_changes' });
    return;
  }

  const input: Partial<Record<EntityName, EntityChange[]>> = {};
  for (const entity of ENTITY_NAMES) {
    const list = (body.changes as Record<string, unknown>)[entity];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > 5000) {
      res.status(400).json({ error: 'invalid_changes', entity });
      return;
    }
    const changes: EntityChange[] = [];
    for (const raw of list as Record<string, unknown>[]) {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) {
        res.status(400).json({ error: 'invalid_change', entity });
        return;
      }
      if (raw.baseRev !== undefined && (!Number.isInteger(raw.baseRev) || (raw.baseRev as number) < 0)) {
        res.status(400).json({ error: 'invalid_base_rev', entity, id: raw.id });
        return;
      }
      const deleted = raw.deleted === true;
      if (!deleted && (raw.data === undefined || raw.data === null || typeof raw.data !== 'object')) {
        res.status(400).json({ error: 'invalid_data', entity, id: raw.id });
        return;
      }
      changes.push({
        id: raw.id,
        baseRev: raw.baseRev as number | undefined,
        deleted,
        data: raw.data,
      });
    }
    input[entity] = changes;
  }

  const result = applyChanges(input);
  // A change means there is now something worth a backup point. The backup
  // itself is throttled, so this is cheap.
  if (result.applied.length) runBackup();
  res.json(result);
});
