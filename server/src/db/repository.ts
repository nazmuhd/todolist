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

/* ---------- per-entity sync ---------- */

export const ENTITY_NAMES = ['projects', 'labels', 'tasks'] as const;
export type EntityName = typeof ENTITY_NAMES[number];

export interface EntityChange {
  id: string;
  data?: unknown;
  deleted?: boolean;
  baseRev?: number;
}

export interface AppliedChange {
  entity: EntityName;
  id: string;
  rev: number;
}

export interface ConflictChange {
  entity: EntityName;
  id: string;
  rev: number;
  data: unknown | null;
  deleted: boolean;
}

export interface EntityChangeRow {
  id: string;
  data?: unknown;
  rev: number;
  deleted: boolean;
}

export type Changes = Record<EntityName, EntityChangeRow[]>;

interface EntityRow {
  entity: EntityName;
  id: string;
  data: string | null;
  rev: number;
  seq: number;
  deleted: number;
}

export interface SyncResult {
  applied: AppliedChange[];
  conflicts: ConflictChange[];
  cursor: number;
}

function getSequence(): number {
  const row = getDb().prepare("select value from sync_meta where key = 'sequence'").get() as { value: string } | undefined;
  return row ? Number(row.value) || 0 : 0;
}

function nextSequence(): number {
  const next = getSequence() + 1;
  getDb().prepare("update sync_meta set value = ? where key = 'sequence'").run(String(next));
  return next;
}

export function getCursor(): number {
  return getSequence();
}

/**
 * Changes after `since`, oldest first. `limit` caps one page; when it does,
 * `hasMore` is true and `cursor` is the last sequence included, so the next
 * request can resume with `since=cursor`.
 */
export function changesSince(
  since: number,
  limit?: number,
): { changes: Changes; cursor: number; hasMore: boolean } {
  const hasLimit = Number.isInteger(limit) && (limit as number) > 0;
  const rows = (hasLimit
    ? getDb().prepare(`
        select entity, id, data, rev, seq, deleted
          from entities
         where seq > ?
         order by seq
         limit ?
      `).all(since, (limit as number) + 1)
    : getDb().prepare(`
        select entity, id, data, rev, seq, deleted
          from entities
         where seq > ?
         order by seq
      `).all(since)) as unknown as EntityRow[];

  const hasMore = hasLimit && rows.length > (limit as number);
  if (hasMore) rows.length = limit as number;

  const changes: Changes = { projects: [], labels: [], tasks: [] };
  for (const row of rows) {
    if (!ENTITY_NAMES.includes(row.entity)) continue;
    changes[row.entity].push({
      id: row.id,
      data: row.deleted || !row.data ? null : JSON.parse(row.data),
      rev: row.rev,
      deleted: Boolean(row.deleted),
    });
  }

  const cursor = rows.length ? rows[rows.length - 1]!.seq : since;
  return { changes, cursor, hasMore };
}

/**
 * Applies per-record changes. Each record is its own transaction boundary in
 * spirit: a stale `baseRev` conflicts for that record only, while the other
 * records in the same request still apply.
 */
export function applyChanges(input: Partial<Record<EntityName, EntityChange[]>>): SyncResult {
  const db = getDb();
  const applied: AppliedChange[] = [];
  const conflicts: ConflictChange[] = [];

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const entity of ENTITY_NAMES) {
      const list = input[entity];
      if (!Array.isArray(list)) continue;

      for (const change of list) {
        const current = db.prepare('select entity, id, data, rev, seq, deleted from entities where entity = ? and id = ?')
          .get(entity, change.id) as EntityRow | undefined;
        const currentRev = current ? current.rev : 0;
        const baseRev = change.baseRev ?? 0;

        if (baseRev !== currentRev) {
          conflicts.push({
            entity,
            id: change.id,
            rev: currentRev,
            data: current && !current.deleted && current.data ? JSON.parse(current.data) : null,
            deleted: Boolean(current?.deleted),
          });
          continue;
        }

        const rev = currentRev + 1;
        const seq = nextSequence();
        const deleted = change.deleted ? 1 : 0;
        const data = deleted ? null : JSON.stringify(change.data ?? null);

        db.prepare(`
          insert into entities (entity, id, data, rev, seq, deleted)
          values (?, ?, ?, ?, ?, ?)
          on conflict (entity, id) do update set
            data = excluded.data,
            rev = excluded.rev,
            seq = excluded.seq,
            deleted = excluded.deleted,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        `).run(entity, change.id, data, rev, seq, deleted);

        applied.push({ entity, id: change.id, rev });
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { applied, conflicts, cursor: getSequence() };
}

/** The live entities, without UI-only state. */
export function exportEntities(): Record<EntityName, unknown[]> {
  const rows = getDb().prepare(`
    select entity, id, data, rev, seq, deleted
      from entities
     where deleted = 0
     order by seq
  `).all() as unknown as EntityRow[];

  const snapshot: Record<EntityName, unknown[]> = { projects: [], labels: [], tasks: [] };
  for (const row of rows) {
    if (!ENTITY_NAMES.includes(row.entity)) continue;
    snapshot[row.entity].push(row.data ? JSON.parse(row.data) : null);
  }
  return snapshot;
}

/**
 * Replaces every entity from a whole-state payload (used for imports and the
 * legacy `/api/state` endpoint). Records that disappear become tombstones.
 */
export function replaceEntities(
  snapshot: Partial<Record<EntityName, unknown[]>>,
  baseRev: number,
  force = false,
): { ok: true; cursor: number } | { ok: false; conflict: true; cursor: number } {
  const db = getDb();
  const cursor = getSequence();
  // A restore is an explicit instruction, so it does not need a matching
  // revision.
  if (!force && baseRev !== cursor) return { ok: false, conflict: true, cursor };

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const entity of ENTITY_NAMES) {
      const incoming = Array.isArray(snapshot[entity]) ? snapshot[entity] as { id?: unknown }[] : [];
      const seen = new Set<string>();

      for (const item of incoming) {
        if (!item || typeof item !== 'object') continue;
        const id = String((item as { id?: unknown }).id ?? '');
        if (!id || seen.has(id)) continue;
        seen.add(id);

        const current = db.prepare('select rev from entities where entity = ? and id = ?')
          .get(entity, id) as { rev: number } | undefined;
        const rev = (current?.rev ?? 0) + 1;
        db.prepare(`
          insert into entities (entity, id, data, rev, seq, deleted)
          values (?, ?, ?, ?, ?, 0)
          on conflict (entity, id) do update set
            data = excluded.data,
            rev = excluded.rev,
            seq = excluded.seq,
            deleted = 0,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        `).run(entity, id, JSON.stringify(item), rev, nextSequence());
      }

      const existing = db.prepare('select id from entities where entity = ? and deleted = 0')
        .all(entity) as { id: string }[];
      for (const row of existing) {
        if (seen.has(row.id)) continue;
        const current = db.prepare('select rev from entities where entity = ? and id = ?')
          .get(entity, row.id) as { rev: number };
        db.prepare(`
          update entities
             set data = null, deleted = 1, rev = ?, seq = ?,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           where entity = ? and id = ?
        `).run(current.rev + 1, nextSequence(), entity, row.id);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { ok: true, cursor: getSequence() };
}

/** Stores a snapshot of the live entities next to the old whole-state backups. */
export function backupEntities(tag: string): boolean {
  const snapshot = exportEntities();
  if (!snapshot.projects.length && !snapshot.labels.length && !snapshot.tasks.length) return false;
  getDb().prepare('insert into state_backups (tag, value) values (?, ?)')
    .run(tag, JSON.stringify(snapshot));
  return true;
}

/* ---------- automatic backups ---------- */

export interface BackupRow {
  id: number;
  tag: string;
  created_at: string;
  size: number;
}

/** The automatic backups, newest first. */
export function listBackups(limit = 50): BackupRow[] {
  return getDb().prepare(`
    select id, tag, created_at, length(value) as size
      from state_backups
     where tag like 'auto-%'
     order by created_at desc, id desc
     limit ?
  `).all(limit) as unknown as BackupRow[];
}

/** The newest automatic backup, if there is one. */
export function latestBackup(): BackupRow | undefined {
  return getDb().prepare(`
    select id, tag, created_at, length(value) as size
      from state_backups
     where tag like 'auto-%'
     order by created_at desc, id desc
     limit 1
  `).get() as BackupRow | undefined;
}

/** Removes the automatic backups beyond the newest `keep`. */
export function pruneBackups(keep: number): number {
  const rows = getDb().prepare(`
    select id from state_backups where tag like 'auto-%' order by created_at desc, id desc
  `).all() as { id: number }[];
  if (rows.length <= keep) return 0;
  const doomed = rows.slice(keep).map(r => r.id);
  const stmt = getDb().prepare('delete from state_backups where id = ?');
  doomed.forEach(id => stmt.run(id));
  return doomed.length;
}

/**
 * Takes an automatic backup if the last one is older than `intervalMs`.
 * Returns true when a new backup was written.
 */
export function maybeBackup(intervalMs: number, keep: number): boolean {
  const latest = latestBackup();
  if (latest) {
    const age = Date.now() - Date.parse(latest.created_at);
    if (Number.isFinite(age) && age < intervalMs) return false;
  }
  const written = backupEntities(`auto-${new Date().toISOString()}`);
  if (written) pruneBackups(keep);
  return written;
}

/**
 * Writes a backup right now, whatever the interval says.
 *
 * This is what the user pressing "Back up now" gets: a snapshot of the
 * data as it is at this moment, not the last scheduled one.
 */
export function forceBackup(keep: number): boolean {
  const written = backupEntities(`auto-${new Date().toISOString()}`);
  if (written) pruneBackups(keep);
  return written;
}

/** The stored value of a backup, for restoring it. */
export function readBackup(id: number): string | undefined {
  const row = getDb().prepare('select value from state_backups where id = ?').get(id) as { value: string } | undefined;
  return row?.value;
}

/* ---------- push subscriptions ---------- */

export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
  label?: string | null;
  user_agent?: string | null;
  created_at?: string | null;
  last_seen_at?: string | null;
}

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  label?: string | null;
  userAgent?: string | null;
}

export function savePushSubscription(sub: PushSubscriptionInput): void {
  getDb().prepare(`
    insert into push_subscriptions (endpoint, p256dh, auth, label, user_agent, last_seen_at)
    values (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    on conflict (endpoint) do update set
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      label = coalesce(excluded.label, push_subscriptions.label),
      user_agent = coalesce(excluded.user_agent, push_subscriptions.user_agent),
      last_seen_at = excluded.last_seen_at
  `).run(sub.endpoint, sub.p256dh, sub.auth, sub.label || null, sub.userAgent || null);
}

export function deletePushSubscription(endpoint: string): boolean {
  return Number(getDb().prepare('delete from push_subscriptions where endpoint = ?').run(endpoint).changes) > 0;
}

export function listPushSubscriptions(): PushSubscriptionRow[] {
  return getDb().prepare(`
    select endpoint, p256dh, auth, label, user_agent, created_at, last_seen_at
    from push_subscriptions
    order by created_at
  `).all() as unknown as PushSubscriptionRow[];
}

/** Public device list: never exposes the push keys. */
export interface PushDevice {
  endpoint: string;
  label: string | null;
  userAgent: string | null;
  createdAt: string | null;
  lastSeenAt: string | null;
}

export function listPushDevices(): PushDevice[] {
  return getDb().prepare(`
    select endpoint, label, user_agent, created_at, last_seen_at
    from push_subscriptions
    order by created_at
  `).all().map((row) => {
    const r = row as unknown as PushSubscriptionRow;
    return {
      endpoint: r.endpoint,
      label: r.label || null,
      userAgent: r.user_agent || null,
      createdAt: r.created_at || null,
      lastSeenAt: r.last_seen_at || null,
    };
  });
}

/* ---------- reminder bookkeeping ---------- */

export function reminderAlreadyFired(taskId: string, reminder: string): boolean {
  return Boolean(getDb().prepare('select 1 from reminder_fired where task_id = ? and reminder = ?')
    .get(taskId, reminder));
}

export function markReminderFired(taskId: string, reminder: string): void {
  getDb().prepare(`
    insert into reminder_fired (task_id, reminder)
    values (?, ?)
    on conflict (task_id, reminder) do update set fired_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).run(taskId, reminder);
}

/** Forgets fired reminders when a task is edited or deleted. */
export function clearReminderFired(taskId: string): void {
  getDb().prepare('delete from reminder_fired where task_id = ?').run(taskId);
}

/* ---------- attachment cleanup ---------- */

/** Every attachment id still referenced by a live task. */
export function referencedAttachmentIds(): Set<string> {
  const rows = getDb().prepare("select data from entities where entity = 'tasks' and deleted = 0")
    .all() as unknown as { data: string | null }[];
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

/**
 * Deletes unreferenced blobs older than `olderThanMs`. The age guard protects
 * an attachment that was uploaded but not yet saved onto a task.
 */
export function removeOrphanBlobs(keep: Set<string>, olderThanMs: number): string[] {
  const rows = getDb().prepare('select key, updated_at from blobs').all() as unknown as {
    key: string;
    updated_at: string;
  }[];
  const cutoff = Date.now() - olderThanMs;
  const removed: string[] = [];
  for (const row of rows) {
    if (keep.has(row.key)) continue;
    const updated = Date.parse(row.updated_at);
    if (Number.isNaN(updated) || updated > cutoff) continue;
    if (deleteBlob(row.key)) removed.push(row.key);
  }
  return removed;
}
