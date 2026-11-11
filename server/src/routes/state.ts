import { Router } from 'express';
import { backupState, readDocument, writeDocument } from '../db/repository.ts';

export const stateRouter = Router();

function encode(data: unknown) {
  return JSON.stringify(data);
}

stateRouter.get('/', (_req, res) => {
  const row = readDocument('state');
  if (!row) {
    // An empty store is not an error: the client seeds it on first save.
    res.json({ data: null, rev: 0, updatedAt: null });
    return;
  }
  let data: unknown;
  try {
    data = JSON.parse(row.value);
  } catch {
    res.status(500).json({ error: 'corrupt_state' });
    return;
  }
  res.json({ data, rev: row.rev, updatedAt: row.updated_at });
});

stateRouter.put('/', (req, res) => {
  const body = req.body as { data?: unknown; baseRev?: unknown } | undefined;
  if (!body || body.data === undefined || typeof body.data !== 'object' || body.data === null) {
    res.status(400).json({ error: 'invalid_state' });
    return;
  }
  if (body.baseRev !== undefined && (typeof body.baseRev !== 'number' || !Number.isInteger(body.baseRev))) {
    res.status(400).json({ error: 'invalid_base_rev' });
    return;
  }

  const result = writeDocument('state', encode(body.data), body.baseRev);
  if (!result.ok) {
    res.status(409).json({ error: 'conflict', rev: result.rev });
    return;
  }
  res.json({ rev: result.row.rev, updatedAt: result.row.updated_at });
});

stateRouter.post('/backup/:tag', (req, res) => {
  const tag = String(req.params.tag || 'backup');
  if (!backupState(tag)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.status(201).json({ ok: true, tag });
});
