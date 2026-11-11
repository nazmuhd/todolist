/**
 * Shared singletons and tiny helpers.
 *
 * Modules import these instead of relying on globals. The objects are
 * mutated in place so every importer always sees the current value.
 */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const settings = {
  theme: 'system',
  startOfWeek: 'mon',
  dateFormat: 'system',
  timeFormat: 'system',
  defaultPriority: null,
  defaultReminder: null,
};

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);


