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

export function readDocument(userId: number, key: string): DocumentRow | undefined {
  return getDb().prepare('select key, value, rev, updated_at from documents where user_id = ? and key = ?')
    .get(userId, key) as DocumentRow | undefined;
}

export function writeDocument(userId: number, key: string, value: string, baseRev?: number): WriteResult {
  const db = getDb();
  const current = readDocument(userId, key);

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
       where user_id = ? and key = ?
    `).run(value, userId, key);
  } else {
    db.prepare('insert into documents (user_id, key, value) values (?, ?, ?)').run(userId, key, value);
  }

  return { ok: true, row: readDocument(userId, key) as DocumentRow };
}

export function deleteDocument(userId: number, key: string): boolean {
  return Number(getDb().prepare('delete from documents where user_id = ? and key = ?').run(userId, key).changes) > 0;
}

export function backupState(userId: number, tag: string): boolean {
  const current = readDocument(userId, 'state');
  if (!current) return false;
  getDb().prepare('insert into state_backups (user_id, tag, value) values (?, ?, ?)').run(userId, tag, current.value);
  return true;
}

export function putBlob(userId: number, key: string, data: Uint8Array, meta: { name?: string; mime?: string } = {}): BlobRow {
  const db = getDb();
  const existing = db.prepare('select rev from blobs where user_id = ? and key = ?').get(userId, key) as { rev: number } | undefined;
  const name = meta.name ?? '';
  const mime = meta.mime ?? '';
  if (existing) {
    db.prepare(`
      update blobs
         set name = ?, mime = ?, size = ?, data = ?, rev = rev + 1,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       where user_id = ? and key = ?
    `).run(name, mime, data.byteLength, data, userId, key);
  } else {
    db.prepare('insert into blobs (user_id, key, name, mime, size, data) values (?, ?, ?, ?, ?, ?)')
      .run(userId, key, name, mime, data.byteLength, data);
  }
  return getBlob(userId, key) as BlobRow;
}

export function getBlob(userId: number, key: string): BlobRow | undefined {
  return getDb().prepare('select key, name, mime, size, data, rev, updated_at from blobs where user_id = ? and key = ?')
    .get(userId, key) as BlobRow | undefined;
}

export function deleteBlob(userId: number, key: string): boolean {
  return Number(getDb().prepare('delete from blobs where user_id = ? and key = ?').run(userId, key).changes) > 0;
}

export function listBlobs(userId: number): BlobMeta[] {
  return getDb().prepare('select key, name, mime, size, rev, updated_at from blobs where user_id = ? order by updated_at desc')
    .all(userId) as BlobMeta[];
}

/* ---------- per-entity sync ---------- */

export const ENTITY_NAMES = ['projects', 'labels', 'tasks'] as const;
export type EntityName = typeof ENTITY_NAMES[number];

export interface EntityChange {
  id: string;
  data?: unknown;
  deleted?: boolean;
  baseRev?: number;
}

export interface AppliedChange { entity: EntityName; id: string; rev: number; }
export interface ConflictChange { entity: EntityName; id: string; rev: number; data: unknown | null; deleted: boolean; }
export interface EntityChangeRow { id: string; data?: unknown; rev: number; deleted: boolean; }
export type Changes = Record<EntityName, EntityChangeRow[]>;

interface EntityRow { entity: EntityName; id: string; data: string | null; rev: number; seq: number; deleted: number; }
export interface SyncResult { applied: AppliedChange[]; conflicts: ConflictChange[]; cursor: number; }

function ensureSequence(userId: number): void {
  getDb().prepare("insert or ignore into sync_meta (user_id, key, value) values (?, 'sequence', '0')").run(userId);
}

function getSequence(userId: number): number {
  ensureSequence(userId);
  const row = getDb().prepare("select value from sync_meta where user_id = ? and key = 'sequence'").get(userId) as { value: string } | undefined;
  return row ? Number(row.value) || 0 : 0;
}

function nextSequence(userId: number): number {
  const next = getSequence(userId) + 1;
  getDb().prepare("update sync_meta set value = ? where user_id = ? and key = 'sequence'").run(String(next), userId);
  return next;
}

export function getCursor(userId: number): number {
  return getSequence(userId);
}

export function changesSince(
  userId: number,
  since: number,
  limit?: number,
): { changes: Changes; cursor: number; hasMore: boolean } {
  const hasLimit = Number.isInteger(limit) && (limit as number) > 0;
  const rows = (hasLimit
    ? getDb().prepare(`
        select entity, id, data, rev, seq, deleted
          from entities
         where user_id = ? and seq > ?
         order by seq
         limit ?
      `).all(userId, since, (limit as number) + 1)
    : getDb().prepare(`
        select entity, id, data, rev, seq, deleted
          from entities
         where user_id = ? and seq > ?
         order by seq
      `).all(userId, since)) as unknown as EntityRow[];

  const hasMore = hasLimit && rows.length > (limit as number);
  if (hasMore) rows.length = limit as number;

  const changes: Changes = { projects: [], labels: [], tasks: [] };
  for (const row of rows) {
    if (!ENTITY_NAMES.includes(row.entity)) continue;
    changes[row.entity].push({ id: row.id, data: row.deleted || !row.data ? null : JSON.parse(row.data), rev: row.rev, deleted: Boolean(row.deleted) });
  }
  const cursor = rows.length ? rows[rows.length - 1]!.seq : since;
  return { changes, cursor, hasMore };
}

export function applyChanges(userId: number, input: Partial<Record<EntityName, EntityChange[]>>): SyncResult {
  const db = getDb();
  const applied: AppliedChange[] = [];
  const conflicts: ConflictChange[] = [];

  db.exec('BEGIN IMMEDIATE');
  try {
    ensureSequence(userId);
    for (const entity of ENTITY_NAMES) {
      const list = input[entity];
      if (!Array.isArray(list)) continue;
      for (const change of list) {
        const current = db.prepare('select entity, id, data, rev, seq, deleted from entities where user_id = ? and entity = ? and id = ?')
          .get(userId, entity, change.id) as EntityRow | undefined;
        const currentRev = current ? current.rev : 0;
        const baseRev = change.baseRev ?? 0;
        if (baseRev !== currentRev) {
          conflicts.push({ entity, id: change.id, rev: currentRev, data: current && !current.deleted && current.data ? JSON.parse(current.data) : null, deleted: Boolean(current?.deleted) });
          continue;
        }
        const rev = currentRev + 1;
        const seq = nextSequence(userId);
        const deleted = change.deleted ? 1 : 0;
        const data = deleted ? null : JSON.stringify(change.data ?? null);
        db.prepare(`
          insert into entities (user_id, entity, id, data, rev, seq, deleted)
          values (?, ?, ?, ?, ?, ?, ?)
          on conflict (user_id, entity, id) do update set
            data = excluded.data, rev = excluded.rev, seq = excluded.seq, deleted = excluded.deleted,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        `).run(userId, entity, change.id, data, rev, seq, deleted);
        applied.push({ entity, id: change.id, rev });
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { applied, conflicts, cursor: getSequence(userId) };
}

export function exportEntities(userId: number): Record<EntityName, unknown[]> {
  const rows = getDb().prepare(`
    select entity, id, data from entities where user_id = ? and deleted = 0 order by seq
  `).all(userId) as unknown as { entity: EntityName; data: string | null }[];
  const snapshot: Record<EntityName, unknown[]> = { projects: [], labels: [], tasks: [] };
  for (const row of rows) {
    if (!ENTITY_NAMES.includes(row.entity)) continue;
    snapshot[row.entity].push(row.data ? JSON.parse(row.data) : null);
  }
  return snapshot;
}

export function replaceEntities(
  userId: number,
  snapshot: Partial<Record<EntityName, unknown[]>>,
  baseRev: number,
  force = false,
): { ok: true; cursor: number } | { ok: false; conflict: true; cursor: number } {
  const db = getDb();
  const cursor = getSequence(userId);
  if (!force && baseRev !== cursor) return { ok: false, conflict: true, cursor };

  db.exec('BEGIN IMMEDIATE');
  try {
    ensureSequence(userId);
    for (const entity of ENTITY_NAMES) {
      const incoming = Array.isArray(snapshot[entity]) ? snapshot[entity] as { id?: unknown }[] : [];
      const seen = new Set<string>();
      for (const item of incoming) {
        if (!item || typeof item !== 'object') continue;
        const id = String((item as { id?: unknown }).id ?? '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const current = db.prepare('select rev from entities where user_id = ? and entity = ? and id = ?').get(userId, entity, id) as { rev: number } | undefined;
        const rev = (current?.rev ?? 0) + 1;
        db.prepare(`
          insert into entities (user_id, entity, id, data, rev, seq, deleted)
          values (?, ?, ?, ?, ?, ?, 0)
          on conflict (user_id, entity, id) do update set
            data = excluded.data, rev = excluded.rev, seq = excluded.seq, deleted = 0,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        `).run(userId, entity, id, JSON.stringify(item), rev, nextSequence(userId));
      }
      const existing = db.prepare('select id from entities where user_id = ? and entity = ? and deleted = 0').all(userId, entity) as { id: string }[];
      for (const row of existing) {
        if (seen.has(row.id)) continue;
        const current = db.prepare('select rev from entities where user_id = ? and entity = ? and id = ?').get(userId, entity, row.id) as { rev: number };
        db.prepare(`
          update entities set data = null, deleted = 1, rev = ?, seq = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           where user_id = ? and entity = ? and id = ?
        `).run(current.rev + 1, nextSequence(userId), userId, entity, row.id);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { ok: true, cursor: getSequence(userId) };
}

export function backupEntities(userId: number, tag: string): boolean {
  const snapshot = exportEntities(userId);
  if (!snapshot.projects.length && !snapshot.labels.length && !snapshot.tasks.length) return false;
  getDb().prepare('insert into state_backups (user_id, tag, value) values (?, ?, ?)')
    .run(userId, tag, JSON.stringify(snapshot));
  return true;
}

/* ---------- automatic backups ---------- */

export interface BackupRow { id: number; tag: string; created_at: string; size: number; }

export function listBackups(userId: number, limit = 50): BackupRow[] {
  return getDb().prepare(`
    select id, tag, created_at, length(value) as size
      from state_backups
     where user_id = ? and tag like 'auto-%'
     order by created_at desc, id desc
     limit ?
  `).all(userId, limit) as unknown as BackupRow[];
}

export function latestBackup(userId: number): BackupRow | undefined {
  return getDb().prepare(`
    select id, tag, created_at, length(value) as size
      from state_backups
     where user_id = ? and tag like 'auto-%'
     order by created_at desc, id desc
     limit 1
  `).get(userId) as BackupRow | undefined;
}

export function pruneBackups(userId: number, keep: number): number {
  const rows = getDb().prepare(`
    select id from state_backups where user_id = ? and tag like 'auto-%' order by created_at desc, id desc
  `).all(userId) as { id: number }[];
  if (rows.length <= keep) return 0;
  const doomed = rows.slice(keep).map(r => r.id);
  const stmt = getDb().prepare('delete from state_backups where id = ? and user_id = ?');
  doomed.forEach(id => stmt.run(id, userId));
  return doomed.length;
}

export function maybeBackup(userId: number, intervalMs: number, keep: number): boolean {
  const latest = latestBackup(userId);
  if (latest) {
    const age = Date.now() - Date.parse(latest.created_at);
    if (Number.isFinite(age) && age < intervalMs) return false;
  }
  const written = backupEntities(userId, `auto-${new Date().toISOString()}`);
  if (written) pruneBackups(userId, keep);
  return written;
}

export function forceBackup(userId: number, keep: number): boolean {
  const written = backupEntities(userId, `auto-${new Date().toISOString()}`);
  if (written) pruneBackups(userId, keep);
  return written;
}

export function readBackup(userId: number, id: number): string | undefined {
  const row = getDb().prepare('select value from state_backups where user_id = ? and id = ?').get(userId, id) as { value: string } | undefined;
  return row?.value;
}

/* ---------- push subscriptions ---------- */

export interface PushSubscriptionRow {
  endpoint: string; p256dh: string; auth: string; label?: string | null; user_agent?: string | null; created_at?: string | null; last_seen_at?: string | null;
}
export interface PushSubscriptionInput { endpoint: string; p256dh: string; auth: string; label?: string | null; userAgent?: string | null; }
export interface PushDevice { endpoint: string; label: string | null; userAgent: string | null; createdAt: string | null; lastSeenAt: string | null; }

export function savePushSubscription(userId: number, sub: PushSubscriptionInput): void {
  getDb().prepare(`
    insert into push_subscriptions (user_id, endpoint, p256dh, auth, label, user_agent, last_seen_at)
    values (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    on conflict (user_id, endpoint) do update set
      p256dh = excluded.p256dh, auth = excluded.auth,
      label = coalesce(excluded.label, push_subscriptions.label),
      user_agent = coalesce(excluded.user_agent, push_subscriptions.user_agent),
      last_seen_at = excluded.last_seen_at
  `).run(userId, sub.endpoint, sub.p256dh, sub.auth, sub.label || null, sub.userAgent || null);
}

export function deletePushSubscription(userId: number, endpoint: string): boolean {
  return Number(getDb().prepare('delete from push_subscriptions where user_id = ? and endpoint = ?').run(userId, endpoint).changes) > 0;
}

export function listPushSubscriptions(userId?: number): (PushSubscriptionRow & { user_id?: number })[] {
  if (userId == null) {
    return getDb().prepare(`select user_id, endpoint, p256dh, auth, label, user_agent, created_at, last_seen_at from push_subscriptions order by created_at`).all() as any;
  }
  return getDb().prepare(`
    select endpoint, p256dh, auth, label, user_agent, created_at, last_seen_at
    from push_subscriptions where user_id = ? order by created_at
  `).all(userId) as any;
}

export function listPushDevices(userId: number): PushDevice[] {
  return getDb().prepare(`
    select endpoint, label, user_agent, created_at, last_seen_at
    from push_subscriptions where user_id = ? order by created_at
  `).all(userId).map((row) => {
    const r = row as unknown as PushSubscriptionRow;
    return { endpoint: r.endpoint, label: r.label || null, userAgent: r.user_agent || null, createdAt: r.created_at || null, lastSeenAt: r.last_seen_at || null };
  });
}

/* ---------- reminder bookkeeping ---------- */

export function reminderAlreadyFired(userId: number, taskId: string, reminder: string): boolean {
  return Boolean(getDb().prepare('select 1 from reminder_fired where user_id = ? and task_id = ? and reminder = ?').get(userId, taskId, reminder));
}

export function markReminderFired(userId: number, taskId: string, reminder: string): void {
  getDb().prepare(`
    insert into reminder_fired (user_id, task_id, reminder) values (?, ?, ?)
    on conflict (user_id, task_id, reminder) do update set fired_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).run(userId, taskId, reminder);
}

export function clearReminderFired(userId: number, taskId: string): void {
  getDb().prepare('delete from reminder_fired where user_id = ? and task_id = ?').run(userId, taskId);
}

/* ---------- attachment cleanup ---------- */

export function referencedAttachmentIds(userId: number): Set<string> {
  const rows = getDb().prepare("select data from entities where user_id = ? and entity = 'tasks' and deleted = 0")
    .all(userId) as unknown as { data: string | null }[];
  const ids = new Set<string>();
  for (const row of rows) {
    if (!row.data) continue;
    let task: unknown;
    try { task = JSON.parse(row.data); } catch { continue; }
    const attachments = (task as { attachments?: unknown }).attachments;
    if (!Array.isArray(attachments)) continue;
    for (const attachment of attachments) {
      const id = attachment && typeof attachment === 'object' ? (attachment as { id?: unknown }).id : null;
      if (typeof id === 'string' && id) ids.add(id);
    }
  }
  return ids;
}

export function removeOrphanBlobs(userId: number, keep: Set<string>, olderThanMs: number): string[] {
  const rows = getDb().prepare('select key, updated_at from blobs where user_id = ?').all(userId) as unknown as { key: string; updated_at: string }[];
  const cutoff = Date.now() - olderThanMs;
  const removed: string[] = [];
  for (const row of rows) {
    if (keep.has(row.key)) continue;
    const updated = Date.parse(row.updated_at);
    if (Number.isNaN(updated) || updated > cutoff) continue;
    if (deleteBlob(userId, row.key)) removed.push(row.key);
  }
  return removed;
}

export function listUserIds(): number[] {
  return (getDb().prepare('select id from users order by id').all() as { id: number }[]).map(r => r.id);
}
