/**
 * Automatic backups.
 *
 * The server keeps a rolling set of snapshots, so there is always something
 * to go back to. This module asks the server for them, takes one on demand,
 * and restores one when the user asks.
 *
 * When no server is running the app still works: the local state in
 * IndexedDB is the live copy, and the export button writes a file.
 */
import { store } from './store.js';
import { showToast } from './toasts.js';
import { requestRender } from './render.js';

/** The backups the server holds, newest first. */
export async function listBackups() {
  const body = await store.jsonBody(await store.send('/state/backups'));
  return Array.isArray(body?.backups) ? body.backups : [];
}

/** Asks the server to take a backup now. */
export async function takeBackup() {
  const body = await store.jsonBody(await store.send('/state/backups', { method: 'POST', json: {} }));
  if (!body) {
    showToast('Could not reach the server, so no backup was taken', 'error');
    return null;
  }
  return Array.isArray(body.backups) ? body.backups : [];
}

/** Removes the oldest backups, keeping `keep` of them. */
export async function pruneBackups(keep) {
  const body = await store.jsonBody(await store.send(`/state/backups?keep=${encodeURIComponent(keep)}`, { method: 'DELETE' }));
  return Array.isArray(body?.backups) ? body.backups : null;
}

/** Restores a backup, replacing the current data with it. */
export async function restoreBackup(id) {
  const body = await store.jsonBody(await store.send(`/state/backups/${encodeURIComponent(id)}/restore`, { method: 'POST', json: {} }));
  if (!body || !body.ok) {
    showToast('Could not restore that backup', 'error');
    return false;
  }
  return true;
}

/** A short, readable description of a backup row. */
export function backupLabel(row) {
  const when = new Date(row.created_at);
  const time = Number.isNaN(when.getTime())
    ? row.created_at
    : when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const size = row.size ? ` · ${Math.max(1, Math.round(row.size / 1024))} KB` : '';
  return `${time}${size}`;
}
