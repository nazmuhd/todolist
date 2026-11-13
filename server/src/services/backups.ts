import { maybeBackup, forceBackup as forceBackupForUser, listBackups as listBackupsForUser, pruneBackups, listUserIds } from '../db/repository.ts';
import { config } from '../config.ts';

export function backupIntervalMinutes(): number { const value = Number(config.backupIntervalMinutes); return Number.isFinite(value) && value > 0 ? value : 60; }
export function backupKeep(): number { const value = Number(config.backupKeep); return Number.isFinite(value) && value > 0 ? value : 24; }

let timer: NodeJS.Timeout | null = null;
const pendingByUser = new Map<number, NodeJS.Timeout>();

export function runBackup(userId: number): boolean {
  try { return maybeBackup(userId, backupIntervalMinutes() * 60_000, backupKeep()); }
  catch (err) { console.error('Automatic backup failed:', err); return false; }
}

export function scheduleBackup(userId: number, delayMs = 5000): void {
  const existing = pendingByUser.get(userId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => { pendingByUser.delete(userId); runBackup(userId); }, delayMs);
  (t as any).unref?.();
  pendingByUser.set(userId, t);
}

export function startBackupWorker(intervalMs = 60_000): void {
  if (timer) return;
  timer = setInterval(() => {
    for (const userId of listUserIds()) {
      runBackup(userId);
      try { pruneBackups(userId, backupKeep()); } catch {}
    }
  }, intervalMs);
  (timer as any).unref?.();
}

export function stopBackupWorker(): void {
  if (timer) { clearInterval(timer); timer = null; }
  for (const t of pendingByUser.values()) clearTimeout(t);
  pendingByUser.clear();
}

export function backups(userId: number) { return listBackupsForUser(userId); }
export function forceBackup(userId: number) { return forceBackupForUser(userId, backupKeep()); }
