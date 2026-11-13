import { Router } from 'express';
import { deleteBlob, getBlob, listBlobs, putBlob, referencedAttachmentIds, removeOrphanBlobs } from '../db/repository.ts';

export const blobsRouter = Router();
const uid = (req: any) => req.user.id as number;

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
  const body = req.body;
  if (!Buffer.isBuffer(body)) { res.status(400).json({ error: 'invalid_blob' }); return; }
  const key = String(req.params.key);
  const rawName = typeof req.headers['x-file-name'] === 'string' ? req.headers['x-file-name'] : '';
  let name = rawName;
  try { name = decodeURIComponent(rawName); } catch {}
  const mime = req.headers['content-type'] || 'application/octet-stream';
  const row = putBlob(uid(req), key, body, { name, mime });
  res.json(meta(row));
});

blobsRouter.get('/:key', (req, res) => {
  const row = getBlob(uid(req), String(req.params.key));
  if (!row) { res.status(404).json({ error: 'not_found' }); return; }
  res.setHeader('Content-Type', row.mime || 'application/octet-stream');
  if (row.name) res.setHeader('Content-Disposition', `inline; filename="${row.name.replace(/"/g, '')}"`);
  res.send(Buffer.from(row.data));
});

blobsRouter.delete('/:key', (req, res) => {
  if (!deleteBlob(uid(req), String(req.params.key))) { res.status(404).json({ error: 'not_found' }); return; }
  res.status(204).end();
});
