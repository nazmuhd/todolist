/**
 * Undo and redo.
 *
 * Keeps the latest destructive action (and its redo) in a local-only IndexedDB
 * document for 24 hours, so Ctrl+Z still works after a reload. A newer save
 * retires the snapshot, so an old undo can never wipe out later edits.
 */
import {
  state, setState, normalizeState, saveState, setStateSavedHook,
  pendingUndo, setPendingUndo, clearPendingUndo,
} from './state.js';
import { store } from './store.js';
import { showToast } from './toasts.js';
import { requestRender } from './render.js';
import { services } from './services.js';

const HISTORY_KEY = 'undo-history';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Only the latest destructive action is kept, matching the toast's single
// Undo: a newer edit must not be wiped out by an older snapshot.
let undoStack = [];
let redoStack = [];
let applyingHistory = false;
let persistTimer = 0;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function capture() {
  return clone({
    projects: state.projects,
    labels: state.labels,
    tasks: state.tasks,
  });
}

function validSnapshot(snapshot) {
  return Boolean(snapshot)
    && Array.isArray(snapshot.projects)
    && Array.isArray(snapshot.labels)
    && Array.isArray(snapshot.tasks);
}

function validEntries(list) {
  const cutoff = Date.now() - MAX_AGE_MS;
  return (Array.isArray(list) ? list : [])
    .filter(entry => entry && validSnapshot(entry.snapshot) && Number.isFinite(entry.at) && entry.at >= cutoff)
    .map(entry => ({
      snapshot: entry.snapshot,
      message: typeof entry.message === 'string' ? entry.message : 'Action',
      at: entry.at,
    }));
}

/** Coalesces the save + offerUndo writes that happen in the same tick. */
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    store.setLocalDoc(HISTORY_KEY, { undo: undoStack, redo: redoStack }).catch(() => {});
  }, 0);
}

/**
 * Any save that is not part of an undo/redo retires the previous snapshot.
 *
 * Installed from the entry point rather than at module scope: state.js,
 * tasks.js and this module form an import cycle, so calling into state.js
 * while this module is still initialising would hit the temporal dead zone.
 */
export function initUndo() {
  setStateSavedHook(() => {
    if (applyingHistory) return;
    undoStack = [];
    redoStack = [];
    persist();
  });
}

function dismissToast() {
  clearPendingUndo();
}

function expireToast(el) {
  if (pendingUndo && pendingUndo.toastEl === el) setPendingUndo(null);
}

/** Replaces the live data with a snapshot. */
function restore(snapshot) {
  setState(normalizeState({
    ...state,
    projects: snapshot.projects,
    labels: snapshot.labels,
    tasks: snapshot.tasks,
  }));
  applyingHistory = true;
  saveState();
  applyingHistory = false;
  requestRender();
  services.syncHash();
}

/** Loads the persisted history. Called once during boot. */
export async function loadUndoHistory() {
  let doc = null;
  try {
    doc = await store.getLocalDoc(HISTORY_KEY);
  } catch {
    doc = null;
  }
  undoStack = validEntries(doc && doc.undo).slice(-1);
  redoStack = validEntries(doc && doc.redo).slice(-1);

  const top = undoStack[undoStack.length - 1];
  if (!top) return;
  let el = null;
  el = showToast(`Undo available: ${top.message}`, 'info', {
    actionLabel: 'Undo',
    duration: 9000,
    onAction: undoPending,
    onTimeout: () => expireToast(el),
  });
  setPendingUndo({ snapshot: top.snapshot, toastEl: el });
}

/** Drops the history, e.g. after an import or a cross-tab replacement. */
export function clearUndoHistory() {
  undoStack = [];
  redoStack = [];
  dismissToast();
  persist();
}

export function snapshotData() {
  return capture();
}

/** Offers an undo toast and records `snapshot` (captured before the action). */
export function offerUndo(message, snapshot) {
  if (!validSnapshot(snapshot)) return;
  undoStack = [{ snapshot, message, at: Date.now() }];
  redoStack = [];
  persist();

  dismissToast();
  let el = null;
  el = showToast(message, 'info', {
    actionLabel: 'Undo',
    duration: 7000,
    onAction: undoPending,
    onTimeout: () => expireToast(el),
  });
  setPendingUndo({ snapshot, toastEl: el });
}

export function undoPending() {
  const entry = undoStack.pop();
  if (!entry) return;

  redoStack = [{ snapshot: capture(), message: entry.message, at: Date.now() }];

  dismissToast();
  restore(entry.snapshot);
  persist();
  showToast('Undone', 'success', {
    actionLabel: 'Redo',
    onAction: redoPending,
    duration: 7000,
  });
}

export function redoPending() {
  const entry = redoStack.pop();
  if (!entry) return;

  undoStack = [{ snapshot: capture(), message: entry.message, at: Date.now() }];

  dismissToast();
  restore(entry.snapshot);
  persist();
  showToast('Redone', 'success', {
    actionLabel: 'Undo',
    onAction: undoPending,
    duration: 7000,
  });
}
