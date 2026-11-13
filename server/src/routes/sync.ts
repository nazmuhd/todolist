import { Router } from 'express';
import { z } from 'zod';
import { applyChanges, changesSince, ENTITY_NAMES, type EntityChange, type EntityName } from '../db/repository.ts';
import { scheduleBackup } from '../services/backups.ts';

export const syncRouter = Router();

function uid(req: any): number { return req.user.id; }

const querySchema = z.object({
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

const entityChangeSchema = z.object({
  id: z.string().min(1).max(200),
  baseRev: z.number().int().min(0).optional(),
  deleted: z.boolean().optional(),
  data: z.unknown().optional(),
}).superRefine((val, ctx) => {
  if (val.deleted === true) return;
  if (val.data === undefined || val.data === null || typeof val.data !== 'object' || Array.isArray(val.data)) {
    ctx.addIssue({ code: 'custom', message: 'invalid_data', path: ['data'] });
  }
});

const changesBodySchema = z.object({
  changes: z.object({
    projects: z.array(entityChangeSchema).max(5000).optional(),
    labels: z.array(entityChangeSchema).max(5000).optional(),
    tasks: z.array(entityChangeSchema).max(5000).optional(),
  }).strict(),
}).strict();

syncRouter.get('/', (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue?.path[0] === 'limit') return res.status(400).json({ error: 'invalid_limit' });
    return res.status(400).json({ error: 'invalid_since' });
  }
  const { since, limit } = parsed.data;
  res.json(changesSince(uid(req), since, limit));
});

syncRouter.post('/', (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || !req.body.changes || typeof req.body.changes !== 'object') {
    return res.status(400).json({ error: 'invalid_changes' });
  }

  const body = req.body as { changes: Record<string, unknown> };
  const input: Partial<Record<EntityName, EntityChange[]>> = {};
  for (const entity of ENTITY_NAMES) {
    const list = body.changes[entity];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > 5000) {
      return res.status(400).json({ error: 'invalid_changes', entity });
    }
    const changes: EntityChange[] = [];
    for (const raw of list as Record<string, unknown>[]) {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) {
        return res.status(400).json({ error: 'invalid_change', entity });
      }
      const parsed = entityChangeSchema.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        if (issue?.message === 'invalid_data' || issue?.path.includes('data')) return res.status(400).json({ error: 'invalid_data', entity, id: raw.id });
        if (issue?.path.includes('baseRev')) return res.status(400).json({ error: 'invalid_base_rev', entity, id: raw.id });
        if (issue?.path.includes('id')) return res.status(400).json({ error: 'invalid_change', entity });
        return res.status(400).json({ error: 'invalid_change', entity, id: raw.id });
      }
      const v = parsed.data;
      changes.push({ id: v.id, baseRev: v.baseRev, deleted: v.deleted === true, data: v.data });
    }
    input[entity] = changes;
  }

  // Reject unknown entity keys to keep payload strict.
  for (const key of Object.keys(body.changes)) {
    if (!ENTITY_NAMES.includes(key as EntityName)) return res.status(400).json({ error: 'invalid_changes', entity: key });
  }

  const result = applyChanges(uid(req), input);
  if (result.applied.length) scheduleBackup(uid(req));
  return res.json(result);
});
