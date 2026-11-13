/**
 * Shared singletons and tiny helpers.
 *
 * Modules import these instead of relying on globals. The objects are
 * mutated in place so every importer always sees the current value.
 */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function cleanRecurrence(v) {
  if (typeof v !== 'string') return null;
  const body = v.trim().toUpperCase();
  if (!body) return null;
  if (!/^[A-Z0-9=;,:+\-]+$/.test(body)) return null;
  const lib = window.rrule;
  if (lib && lib.RRule && typeof lib.RRule.parseString === 'function') {
    try { lib.RRule.parseString(body); } catch { return null; }
  }
  return body;
}

export const settings = {
  theme: 'system',
  startOfWeek: 'mon',
  dateFormat: 'system',
  timeFormat: 'system',
  defaultPriority: null,
  defaultReminder: null,
  profile: null,
};

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/**
 * The task dialog's live draft.
 *
 * The dialog and the due-date editor are separate modules that operate on
 * the same draft, so it lives here with the other shared singletons rather
 * than in either module (which would make them import each other).
 */
export const modalState = {
  editingTaskId: null,
  draft: null,
};


