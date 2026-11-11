/**
 * Undo and redo.
 *
 * Only the most recent destructive action can be undone (like Todoist's
 * toast), and that action can be redone.
 */
import { state, setState, normalizeState } from './state.js';
import { showToast } from './toasts.js';

export let pendingUndo = null;

export let redoSnapshot = null;


export function snapshotData() {
  return JSON.parse(JSON.stringify({
    projects: state.projects,
    labels: state.labels,
    tasks: state.tasks,
  }));
}

/** Offers an undo toast that restores `snapshot` (captured before the action). */
export function offerUndo(message, snapshot) {
  const el = showToast(message, 'info', {
    actionLabel: 'Undo',
    duration: 7000,
    onAction: undoPending,
    onTimeout: () => {
      if (pendingUndo && pendingUndo.toastEl === el) pendingUndo = null;
    },
  });
  pendingUndo = { snapshot, toastEl: el };
}

export function undoPending() {
  if (!pendingUndo) return;
  const { snapshot } = pendingUndo;
  clearPendingUndo();

  // Remember the current state so the undo itself can be redone.
  redoSnapshot = {
    projects: state.projects,
    labels: state.labels,
    tasks: state.tasks,
  };

  setState(normalizeState({
    ...state,
    projects: snapshot.projects,
    labels: snapshot.labels,
    tasks: snapshot.tasks,
  }));
  saveState();
  render();
  syncHash();
  showToast('Undone', 'success', {
    actionLabel: 'Redo',
    onAction: redoPending,
    duration: 7000,
  });
}

export function redoPending() {
  if (!redoSnapshot) return;
  const snapshot = redoSnapshot;
  redoSnapshot = null;
  setState(normalizeState({
    ...state,
    projects: snapshot.projects,
    labels: snapshot.labels,
    tasks: snapshot.tasks,
  }));
  saveState();
  render();
  syncHash();
  showToast('Redone', 'success');
}

export function clearPendingUndo() {
  if (!pendingUndo) return;
  const el = pendingUndo.toastEl;
  pendingUndo = null;
  if (el && el.parentNode) el.remove();
}
