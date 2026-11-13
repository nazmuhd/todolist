/**
 * The list of saved filters.
 *
 * It lives in core because the state normaliser validates the active
 * view against it (a saved filter can be the view the app opens on).
 * The feature that owns the UI - features/filters.js - fills it in.
 */
export const savedFilters = [];

export function normalizeSavedFilter(f) {
  if (!f || typeof f !== 'object') return null;
  const id = typeof f.id === 'string' ? f.id : '';
  const name = typeof f.name === 'string' ? f.name : '';
  const query = typeof f.query === 'string' ? f.query : '';
  if (!id || !name || !query) return null;
  const layout = ['list', 'board', 'table'].includes(f.layout) ? f.layout : null;
  const sort = ['manual', 'date', 'priority', 'name', 'added'].includes(f.sort) ? f.sort : null;
  return { id, name, query, pinned: !!f.pinned, layout, sort };
}

/** Replaces the list in place, so importers always see the current one. */
export function setSavedFilters(list) {
  savedFilters.length = 0;
  (Array.isArray(list) ? list : []).forEach(f => {
    const n = normalizeSavedFilter(f);
    if (n) savedFilters.push(n);
  });
}

export function savedFilterIds() {
  return savedFilters.map(f => f.id);
}

export function findSavedFilter(id) {
  return savedFilters.find(f => f.id === id) || null;
}
