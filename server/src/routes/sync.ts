import { Router } from 'express';
import { applyChanges, changesSince, ENTITY_NAMES, type EntityChange, type EntityName } from '../db/repository.ts';

export const syncRouter = Router();

syncRouter.get('/', (req, res) => {
  const since = Number(req.query.since ?? 0);
  if (!Number.isInteger(since) || since < 0) {
    res.status(400).json({ error: 'invalid_since' });
    return;
  }
  res.json(changesSince(since));
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

  res.json(applyChanges(input));
});
