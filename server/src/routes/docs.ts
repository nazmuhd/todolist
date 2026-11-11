import { Router } from 'express';
import { deleteDocument, readDocument, writeDocument } from '../db/repository.ts';

export const docsRouter = Router();

docsRouter.get('/:key', (req, res) => {
  const row = readDocument(String(req.params.key));
  if (!row) {
    // Missing side documents are normal on a first run.
    res.json({ data: null, rev: 0, updatedAt: null });
    return;
  }
  let data: unknown;
  try {
    data = JSON.parse(row.value);
  } catch {
    res.status(500).json({ error: 'corrupt_document' });
    return;
  }
  res.json({ data, rev: row.rev, updatedAt: row.updated_at });
});

docsRouter.put('/:key', (req, res) => {
  const body = req.body as { data?: unknown; baseRev?: unknown } | undefined;
  if (!body || body.data === undefined) {
    res.status(400).json({ error: 'invalid_document' });
    return;
  }
  if (body.baseRev !== undefined && (typeof body.baseRev !== 'number' || !Number.isInteger(body.baseRev))) {
    res.status(400).json({ error: 'invalid_base_rev' });
    return;
  }

  const key = String(req.params.key);
  const result = writeDocument(key, JSON.stringify(body.data), body.baseRev);
  if (!result.ok) {
    res.status(409).json({ error: 'conflict', rev: result.rev });
    return;
  }
  res.json({ rev: result.row.rev, updatedAt: result.row.updated_at });
});

docsRouter.delete('/:key', (req, res) => {
  if (!deleteDocument(String(req.params.key))) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.status(204).end();
});
