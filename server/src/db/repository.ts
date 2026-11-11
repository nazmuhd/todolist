import { getDb } from './index.ts';

export interface DocumentRow {
  key: string;
  value: string;
  rev: number;
  updated_at: string;
}

export interface BlobRow {
  key: string;
  name: string;
  mime: string;
  size: number;
  data: Uint8Array;
  rev: number;
  updated_at: string;
}

export type BlobMeta = Omit<BlobRow, 'data'>;

export type WriteResult =
  | { ok: true; row: DocumentRow }
  | { ok: false; conflict: true; rev: number };

export function readDocument(key: string): DocumentRow | undefined {
  return getDb().prepare('select key, value, rev, updated_at from documents where key = ?')
    .get(key) as DocumentRow | undefined;
}

/**
 * Writes a document. When `baseRev` is supplied, a mismatched current revision
 * is reported as a conflict instead of overwriting the other writer.
 */
export function writeDocument(key: string, value: string, baseRev?: number): WriteResult {
  const db = getDb();
  const current = readDocument(key);

  if (baseRev !== undefined && baseRev !== null) {
    const currentRev = current ? current.rev : 0;
    if (baseRev !== currentRev) {
      return { ok: false, conflict: true, rev: currentRev };
    }
  }

  if (current) {
    db.prepare(`
      update documents
         set value = ?, rev = rev + 1,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       where key = ?
    `).run(value, key);
  } else {
    db.prepare('insert into documents (key, value) values (?, ?)').run(key, value);
  }

  return { ok: true, row: readDocument(key) as DocumentRow };
}

export function deleteDocument(key: string): boolean {
  return Number(getDb().prepare('delete from documents where key = ?').run(key).changes) > 0;
}

/** Keeps a copy of the current state under a named tag. */
export function backupState(tag: string): boolean {
  const current = readDocument('state');
  if (!current) return false;
  getDb().prepare('insert into state_backups (tag, value) values (?, ?)').run(tag, current.value);
  return true;
}

export function putBlob(key: string, data: Uint8Array, meta: { name?: string; mime?: string } = {}): BlobRow {
  const db = getDb();
  const existing = db.prepare('select rev from blobs where key = ?').get(key) as { rev: number } | undefined;
  const name = meta.name ?? '';
  const mime = meta.mime ?? '';
  if (existing) {
    db.prepare(`
      update blobs
         set name = ?, mime = ?, size = ?, data = ?, rev = rev + 1,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       where key = ?
    `).run(name, mime, data.byteLength, data, key);
  } else {
    db.prepare('insert into blobs (key, name, mime, size, data) values (?, ?, ?, ?, ?)')
      .run(key, name, mime, data.byteLength, data);
  }
  return getBlob(key) as BlobRow;
}

export function getBlob(key: string): BlobRow | undefined {
  return getDb().prepare('select key, name, mime, size, data, rev, updated_at from blobs where key = ?')
    .get(key) as BlobRow | undefined;
}

export function deleteBlob(key: string): boolean {
  return Number(getDb().prepare('delete from blobs where key = ?').run(key).changes) > 0;
}

export function listBlobs(): BlobMeta[] {
  return getDb().prepare('select key, name, mime, size, rev, updated_at from blobs order by updated_at desc')
    .all() as BlobMeta[];
}
