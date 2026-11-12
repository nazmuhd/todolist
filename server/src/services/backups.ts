/**
 * Automatic backups.
 *
 * The server keeps a rolling set of snapshots of the data, so there is
 * always something to go back to if something goes wrong. A backup is taken
 * when the last one is older than the interval, and the oldest ones are
 * pruned so the set stays a sensible size.
 *
 * The settings live in the environment:
 *   BACKUP_INTERVAL_MINUTES  how often to take one (default 60)
 *   BACKUP_KEEP              how many to keep (default 24)
 */
import { maybeBackup, forceBackup, listBackups, pruneBackups } from '../db/repository.ts';
import { config } from '../config.ts';

/** How often a backup is taken, in minutes. */
export function backupIntervalMinutes(): number {
  const value = Number(config.backupIntervalMinutes);
  return Number.isFinite(value) && value > 0 ? value : 60;
}

/** How many backups are kept. */
export function backupKeep(): number {
  const value = Number(config.backupKeep);
  return Number.isFinite(value) && value > 0 ? value : 24;
}

let timer: NodeJS.Timeout | null = null;

/** Takes a backup if one is due. Safe to call at any time. */
export function runBackup(): boolean {
  try {
    return maybeBackup(backupIntervalMinutes() * 60_000, backupKeep());
  } catch (err) {
    console.error('Automatic backup failed:', err);
    return false;
  }
}

/**
 * Schedules a backup after the writes settle.
 *
 * A client that syncs in bursts would otherwise trigger a backup in the
 * middle of the burst, capturing a half-written database. Waiting a moment
 * means the snapshot is of the finished data.
 */
let pending: NodeJS.Timeout | null = null;

export function scheduleBackup(delayMs = 5000): void {
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    runBackup();
  }, delayMs);
  pending.unref?.();
}

/** Starts the backup loop. Safe to call once. */
export function startBackupWorker(intervalMs = 60_000): void {
  if (timer) return;
  // No backup at boot: the database is usually empty then, and a snapshot of
  // nothing is not worth keeping. The first change schedules one.
  timer = setInterval(() => {
    runBackup();
    // The keep count can change, so the old ones are pruned on every pass.
    try { pruneBackups(backupKeep()); } catch { /* best effort */ }
  }, intervalMs);
  timer.unref?.();
}

export function stopBackupWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** The backups that are kept, newest first. */
export function backups() {
  return listBackups();
}
