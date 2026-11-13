/**
 * The list of saved filters.
 *
 * Saved filters are first-class state entities (synced/persisted with app state).
 * This module keeps a stable live array reference for existing importers and
 * mirrors `state.filters`.
 */
export const savedFilters = [];

let persistHook = null;
export function bindSavedFiltersPersistence(fn) { persistHook = fn; }

export function normalizeSavedFilter(f) {
  if (!f || typeof f !== 'object') return null;
  const id = typeof f.id === 'string' ? f.id : '';
  const name = typeof f.name === 'string' ? f.name.trim() : '';
  const query = typeof f.query === 'string' ? f.query.trim() : '';
  if (!id || !name || !query) return null;
  const layout = ['list', 'board', 'table'].includes(f.layout) ? f.layout : null;
  const sort = ['manual', 'date', 'priority', 'name', 'added'].includes(f.sort) ? f.sort : null;
  return { id, name, query, pinned: !!f.pinned, layout, sort };
}

function normalizeList(list) {
  return (Array.isArray(list) ? list : []).map(normalizeSavedFilter).filter(Boolean);
}

/** Replaces the exported list in place and returns the normalized array. */
export function setSavedFilters(list) {
  const normalized = normalizeList(list);
  savedFilters.length = 0;
  normalized.forEach(f => savedFilters.push(f));
  return savedFilters;
}

/** Syncs the exported array with state.filters and makes state use the same array. */
export function syncSavedFiltersState(nextState) {
  if (!nextState || typeof nextState !== 'object') return savedFilters;
  const normalized = normalizeList(nextState.filters);
  savedFilters.length = 0;
  normalized.forEach(f => savedFilters.push(f));
  nextState.filters = savedFilters;
  return savedFilters;
}

export function persistSavedFilters() {
  if (persistHook) persistHook();
}

export function savedFilterIds() {
  return savedFilters.map(f => f.id);
}

export function findSavedFilter(id) {
  return savedFilters.find(f => f.id === id) || null;
}
