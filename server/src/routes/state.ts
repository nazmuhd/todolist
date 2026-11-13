import { Router } from 'express';
import { z } from 'zod';
import {
  backupEntities, exportEntities, getCursor, replaceEntities,
  listBackups, readBackup, maybeBackup, forceBackup, pruneBackups,
  ENTITY_NAMES, type EntityName,
} from '../db/repository.ts';

export const stateRouter = Router();
const uid = (req: any) => req.user.id as number;

const putSchema = z.object({
  data: z.record(z.string(), z.unknown()),
  baseRev: z.number().int().min(0).optional(),
}).strict();

const backupBodySchema = z.object({
  intervalMinutes: z.union([z.number(), z.string()]).optional(),
  keep: z.union([z.number(), z.string()]).optional(),
}).passthrough().optional();

stateRouter.get('/', (req, res) => {
  const userId = uid(req);
  res.json({ data: exportEntities(userId), rev: getCursor(userId), updatedAt: null });
});

stateRouter.put('/', (req, res) => {
  const userId = uid(req);
  const body = req.body as { data?: unknown; baseRev?: unknown } | undefined;
  if (!body || !body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
    res.status(400).json({ error: 'invalid_state' });
    return;
  }
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue?.path.includes('baseRev')) return res.status(400).json({ error: 'invalid_base_rev' });
    return res.status(400).json({ error: 'invalid_state' });
  }

  const snapshot = parsed.data.data as Partial<Record<EntityName, unknown[]>>;
  for (const entity of ENTITY_NAMES) {
    if (snapshot[entity] !== undefined && !Array.isArray(snapshot[entity])) {
      res.status(400).json({ error: 'invalid_state', entity });
      return;
    }
  }
  for (const key of Object.keys(snapshot)) {
    if (!ENTITY_NAMES.includes(key as EntityName)) return res.status(400).json({ error: 'invalid_state', entity: key });
  }

  const result = replaceEntities(userId, snapshot, parsed.data.baseRev ?? 0);
  if (!result.ok) { res.status(409).json({ error: 'conflict', rev: result.cursor }); return; }
  res.json({ rev: result.cursor, updatedAt: null });
});

stateRouter.post('/backup/:tag', (req, res) => {
  const tag = String(req.params.tag || 'backup').slice(0, 100);
  if (!backupEntities(uid(req), tag)) { res.status(404).json({ error: 'not_found' }); return; }
  res.status(201).json({ ok: true, tag });
});

stateRouter.get('/backups', (req, res) => { res.json({ backups: listBackups(uid(req)) }); });

stateRouter.post('/backups', (req, res) => {
  const userId = uid(req);
  backupBodySchema.safeParse(req.body); // tolerate current clients; values coerced below
  const body = req.body as { intervalMinutes?: unknown; keep?: unknown } | undefined;
  const keepNum = Number(body?.keep);
  const keep = Number.isFinite(keepNum) && keepNum > 0 ? Math.floor(keepNum) : 24;
  const rawInterval = Number(body?.intervalMinutes);
  const given = body?.intervalMinutes !== undefined && Number.isFinite(rawInterval);
  let written;
  if (!given) written = forceBackup(userId, keep);
  else {
    const intervalMinutes = rawInterval >= 0 ? rawInterval : 60;
    written = intervalMinutes === 0 ? forceBackup(userId, keep) : maybeBackup(userId, intervalMinutes * 60_000, keep);
  }
  res.json({ ok: true, written, backups: listBackups(userId) });
});

stateRouter.delete('/backups', (req, res) => {
  const userId = uid(req);
  const keepNum = Number(req.query.keep);
  const keep = Number.isFinite(keepNum) && keepNum > 0 ? Math.floor(keepNum) : 24;
  const removed = pruneBackups(userId, keep);
  res.json({ ok: true, removed, backups: listBackups(userId) });
});

stateRouter.post('/backups/:id/restore', (req, res) => {
  const userId = uid(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ error: 'invalid_id' }); return; }
  const value = readBackup(userId, id);
  if (!value) { res.status(404).json({ error: 'not_found' }); return; }
  let snapshot: Partial<Record<EntityName, unknown[]>>;
  try { snapshot = JSON.parse(value) as Partial<Record<EntityName, unknown[]>>; }
  catch { res.status(400).json({ error: 'invalid_backup' }); return; }
  const result = replaceEntities(userId, snapshot, 0, true);
  if (!result.ok) { res.status(409).json({ error: 'conflict', rev: result.cursor }); return; }
  res.json({ ok: true, rev: result.cursor });
});
