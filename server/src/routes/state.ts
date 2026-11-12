import { Router } from 'express';
import {
  backupEntities,
  exportEntities,
  getCursor,
  replaceEntities,
  listBackups,
  readBackup,
  maybeBackup,
  forceBackup,
  pruneBackups,
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

/* ---------- automatic backups ---------- */

/** The automatic backups, newest first. */
stateRouter.get('/backups', (_req, res) => {
  res.json({ backups: listBackups() });
});

/**
 * Takes a backup now.
 *
 * Asking for one means asking for a snapshot of the data as it is right
 * now, so this always writes a fresh one. An explicit interval is honoured
 * when given (an interval of 0 also means "always due").
 */
stateRouter.post('/backups', (req, res) => {
  const body = req.body as { intervalMinutes?: unknown; keep?: unknown } | undefined;
  const keep = Number(body?.keep) > 0 ? Number(body?.keep) : 24;
  const rawInterval = Number(body?.intervalMinutes);
  const given = body?.intervalMinutes !== undefined && Number.isFinite(rawInterval);

  let written;
  if (!given) {
    written = forceBackup(keep);
  } else {
    const intervalMinutes = rawInterval >= 0 ? rawInterval : 60;
    written = intervalMinutes === 0
      ? forceBackup(keep)
      : maybeBackup(intervalMinutes * 60_000, keep);
  }
  res.json({ ok: true, written, backups: listBackups() });
});

/** Removes the automatic backups beyond the newest `keep`. */
stateRouter.delete('/backups', (req, res) => {
  const keep = Number(req.query.keep) > 0 ? Number(req.query.keep) : 24;
  const removed = pruneBackups(keep);
  res.json({ ok: true, removed, backups: listBackups() });
});

/** Restores a backup, replacing the live entities with it. */
stateRouter.post('/backups/:id/restore', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'invalid_id' });
    return;
  }
  const value = readBackup(id);
  if (!value) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  let snapshot: Partial<Record<EntityName, unknown[]>>;
  try {
    snapshot = JSON.parse(value) as Partial<Record<EntityName, unknown[]>>;
  } catch {
    res.status(400).json({ error: 'invalid_backup' });
    return;
  }
  const result = replaceEntities(snapshot, 0, true);
  if (!result.ok) {
    res.status(409).json({ error: 'conflict', rev: result.cursor });
    return;
  }
  res.json({ ok: true, rev: result.cursor });
});
