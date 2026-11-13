import { Router } from 'express';
import { z } from 'zod';
import { deleteBlob, getBlob, listBlobs, putBlob, referencedAttachmentIds, removeOrphanBlobs } from '../db/repository.ts';

export const blobsRouter = Router();
const uid = (req: any) => req.user.id as number;

const keySchema = z.string().min(1).max(500);

function meta(row: { key: string; name: string; mime: string; size: number; rev: number }) {
  return { key: row.key, name: row.name, mime: row.mime, size: row.size, rev: row.rev };
}

blobsRouter.get('/', (req, res) => { res.json(listBlobs(uid(req)).map(meta)); });

blobsRouter.post('/cleanup', (req, res) => {
  const userId = uid(req);
  const raw = Number(req.query.olderThanHours ?? 24);
  if (!Number.isFinite(raw) || raw < 1 || raw > 24 * 365) { res.status(400).json({ error: 'invalid_age' }); return; }
  const removed = removeOrphanBlobs(userId, referencedAttachmentIds(userId), raw * 60 * 60 * 1000);
  res.json({ removed: removed.length, keys: removed });
});

blobsRouter.put('/:key', (req, res) => {
  const keyParsed = keySchema.safeParse(String(req.params.key));
  if (!keyParsed.success) return res.status(400).json({ error: 'invalid_key' });
  const body = req.body;
  if (!Buffer.isBuffer(body)) { res.status(400).json({ error: 'invalid_blob' }); return; }
  const key = keyParsed.data;
  const rawName = typeof req.headers['x-file-name'] === 'string' ? req.headers['x-file-name'] : '';
  let name = rawName;
  try { name = decodeURIComponent(rawName); } catch {}
  name = String(name).slice(0, 255);
  const mime = String(req.headers['content-type'] || 'application/octet-stream').slice(0, 200);
  const row = putBlob(uid(req), key, body, { name, mime });
  res.json(meta(row));
});

blobsRouter.get('/:key', (req, res) => {
  const keyParsed = keySchema.safeParse(String(req.params.key));
  if (!keyParsed.success) return res.status(400).json({ error: 'invalid_key' });
  const row = getBlob(uid(req), keyParsed.data);
  if (!row) { res.status(404).json({ error: 'not_found' }); return; }
  res.setHeader('Content-Type', row.mime || 'application/octet-stream');
  if (row.name) res.setHeader('Content-Disposition', `inline; filename="${row.name.replace(/["\\\r\n]/g, '')}"`);
  res.send(Buffer.from(row.data));
});

blobsRouter.delete('/:key', (req, res) => {
  const keyParsed = keySchema.safeParse(String(req.params.key));
  if (!keyParsed.success) return res.status(400).json({ error: 'invalid_key' });
  if (!deleteBlob(uid(req), keyParsed.data)) { res.status(404).json({ error: 'not_found' }); return; }
  res.status(204).end();
});
