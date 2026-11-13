import { Router } from 'express';
import {
  backupEntities, exportEntities, getCursor, replaceEntities,
  listBackups, readBackup, maybeBackup, forceBackup, pruneBackups,
  ENTITY_NAMES, type EntityName,
} from '../db/repository.ts';

export const stateRouter = Router();
const uid = (req: any) => req.user.id as number;

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
  const result = replaceEntities(userId, snapshot, body.baseRev ?? 0);
  if (!result.ok) { res.status(409).json({ error: 'conflict', rev: result.cursor }); return; }
  res.json({ rev: result.cursor, updatedAt: null });
});

stateRouter.post('/backup/:tag', (req, res) => {
  const tag = String(req.params.tag || 'backup');
  if (!backupEntities(uid(req), tag)) { res.status(404).json({ error: 'not_found' }); return; }
  res.status(201).json({ ok: true, tag });
});

stateRouter.get('/backups', (req, res) => { res.json({ backups: listBackups(uid(req)) }); });

stateRouter.post('/backups', (req, res) => {
  const userId = uid(req);
  const body = req.body as { intervalMinutes?: unknown; keep?: unknown } | undefined;
  const keep = Number(body?.keep) > 0 ? Number(body?.keep) : 24;
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
  const keep = Number(req.query.keep) > 0 ? Number(req.query.keep) : 24;
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
