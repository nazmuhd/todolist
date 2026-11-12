/**
 * Deep links.
 *
 * The current view (and search) live in the URL hash, so views can be shared
 * and the browser back button works.
 */
import { state, saveState } from './state.js';
import { savedFilters } from './saved-filters.js';
import { requestRender } from './render.js';
import { $, modalState } from './app.js';
import { services } from './services.js';

/** Parses `#/task/<id>` into a task id, or null for a normal view. */
export function taskIdFromHash(hash = location.hash) {
  const raw = String(hash || '').replace(/^#\/?/, '');
  const match = /^task\/([^?]+)/.exec(raw);
  return match ? decodeURIComponent(match[1]) : null;
}

/** Makes a task modal deep-linkable without changing the current view. */
export function setTaskHash(id) {
  const next = `#/task/${encodeURIComponent(id)}`;
  if (location.hash !== next) location.hash = next;
}

/** Restores the normal view hash after a task modal closes. */
export function clearTaskHash() {
  if (!taskIdFromHash()) return;
  const next = currentHash();
  if (location.hash !== next) location.hash = next;
}

export function isKnownView(view) {
  if (['inbox', 'today', 'upcoming', 'calendar', 'completed', 'no-date', 'no-priority'].includes(view)) return true;
  if (view.startsWith('project:')) return state.projects.some(p => p.id === view.slice(8));
  if (view.startsWith('label:')) return state.labels.some(l => l.id === view.slice(6));
  if (view.startsWith('filter:')) return savedFilters.some(f => f.id === view.slice(7));
  return false;
}

function currentHash() {
  const q = (state.ui.search || '').trim();
  return `#/${state.ui.view}${q ? `?q=${encodeURIComponent(q)}` : ''}`;
}

export function syncHash() {
  const next = currentHash();
  if (location.hash !== next) location.hash = next;
}

export function applyHash() {
  const taskId = taskIdFromHash();
  if (taskId) {
    if (modalState.editingTaskId === taskId) return;
    if (state.tasks.some(t => t.id === taskId)) services.openTaskModal(taskId);
    return;
  }
  const raw = location.hash.replace(/^#\/?/, '');
  if (!raw) return;
  const [viewPart, queryPart] = raw.split('?');
  const view = decodeURIComponent(viewPart || 'inbox');
  const q = queryPart ? (new URLSearchParams(queryPart).get('q') || '') : '';
  if (!isKnownView(view)) return;
  if (view === state.ui.view && q === (state.ui.search || '')) return;
  state.ui.view = view;
  state.ui.search = q;
  const input = $('#search-input');
  if (input) input.value = q;
  saveState();
  requestRender();
}

export function pulseViewIn() {
  const el = $('#content-container');
  if (!el) return;
  el.classList.remove('view-enter');
  void el.offsetWidth;
  el.classList.add('view-enter');
}

export function navigateTo(view) {
  state.ui.view = view;
  state.ui.search = '';
  $('#search-input').value = '';
  saveState();
  requestRender();
  syncHash();
  pulseViewIn();
}

window.addEventListener('hashchange', applyHash);
