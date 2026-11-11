/**
 * The list of saved filters.
 *
 * It lives in core because the state normaliser validates the active
 * view against it (a saved filter can be the view the app opens on).
 * The feature that owns the UI - features/filters.js - fills it in.
 */
export const savedFilters = [];

/** Replaces the list in place, so importers always see the current one. */
export function setSavedFilters(list) {
  savedFilters.length = 0;
  (Array.isArray(list) ? list : []).forEach(f => savedFilters.push(f));
}

export function savedFilterIds() {
  return savedFilters.map(f => f.id);
}

export function findSavedFilter(id) {
  return savedFilters.find(f => f.id === id) || null;
}
