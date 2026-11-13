import { Router } from 'express';
import { z } from 'zod';
import { deleteDocument, readDocument, writeDocument } from '../db/repository.ts';

export const docsRouter = Router();
const uid = (req: any) => req.user.id as number;

const keySchema = z.string().min(1).max(500);
const putSchema = z.object({
  data: z.unknown(),
  baseRev: z.number().int().min(0).optional(),
}).strict();

docsRouter.get('/:key', (req, res) => {
  const keyParsed = keySchema.safeParse(String(req.params.key));
  if (!keyParsed.success) return res.status(400).json({ error: 'invalid_key' });
  const row = readDocument(uid(req), keyParsed.data);
  if (!row) { res.json({ data: null, rev: 0, updatedAt: null }); return; }
  let data: unknown;
  try { data = JSON.parse(row.value); }
  catch { res.status(500).json({ error: 'corrupt_document' }); return; }
  res.json({ data, rev: row.rev, updatedAt: row.updated_at });
});

docsRouter.put('/:key', (req, res) => {
  const keyParsed = keySchema.safeParse(String(req.params.key));
  if (!keyParsed.success) return res.status(400).json({ error: 'invalid_key' });
  const body = req.body as { data?: unknown; baseRev?: unknown } | undefined;
  if (!body || body.data === undefined) { res.status(400).json({ error: 'invalid_document' }); return; }
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue?.path.includes('baseRev')) return res.status(400).json({ error: 'invalid_base_rev' });
    return res.status(400).json({ error: 'invalid_document' });
  }
  const result = writeDocument(uid(req), keyParsed.data, JSON.stringify(parsed.data.data), parsed.data.baseRev);
  if (!result.ok) { res.status(409).json({ error: 'conflict', rev: result.rev }); return; }
  res.json({ rev: result.row.rev, updatedAt: result.row.updated_at });
});

docsRouter.delete('/:key', (req, res) => {
  const keyParsed = keySchema.safeParse(String(req.params.key));
  if (!keyParsed.success) return res.status(400).json({ error: 'invalid_key' });
  if (!deleteDocument(uid(req), keyParsed.data)) { res.status(404).json({ error: 'not_found' }); return; }
  res.status(204).end();
});
