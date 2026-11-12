/**
 * The filter query language.
 *
 * "p1 | p2", "overdue & !#work", "7 days", "@urgent" — a query is parsed into
 * a predicate that a task is matched against.
 */
import { state, saveState } from '../core/state.js';
import { isTaskOverdue, todayISO, daysFromToday, nextWeekdayISO, toISODate, QUERY_WEEKDAYS } from '../core/dates.js';
import { activeTasks, taskReminders } from '../core/tasks.js';
import { store } from '../core/store.js';
import { uid } from '../core/app.js';
import { requestRender } from '../core/render.js';
import { services } from '../core/services.js';
import { showToast } from '../core/toasts.js';
import { savedFilters, setSavedFilters, findSavedFilter } from '../core/saved-filters.js';

/* ============================================================
   SAVED FILTERS
   Stored beside the app state so the task schema stays untouched.
   ============================================================ */

/** Reads the saved filters from the store. */
export async function loadSavedFilters() {
  const raw = await store.getDoc(store.keys.filters);
  if (!Array.isArray(raw)) {
    setSavedFilters([]);
    return;
  }
  setSavedFilters(raw
    .filter(f => f && typeof f.id === 'string' && typeof f.name === 'string' && typeof f.query === 'string')
    .map(f => ({ id: f.id, name: f.name, query: f.query })));
}

export function persistSavedFilters() {
  store.setDoc(store.keys.filters, savedFilters).catch(err => console.error('Could not save filters:', err));
}

/** How many open tasks a saved filter currently matches. */
export function filterTaskCount(query) {
  const fn = queryMatcher(query);
  return activeTasks().filter(t => fn(t)).length;
}

/** Creates a filter, or updates the one with the same id. */
export function upsertSavedFilter(id, name, query) {
  const existing = findSavedFilter(id);
  if (existing) {
    existing.name = name;
    existing.query = query;
  } else {
    savedFilters.push({ id, name, query });
  }
  persistSavedFilters();
}

export function deleteSavedFilter(id) {
  setSavedFilters(savedFilters.filter(f => f.id !== id));
  persistSavedFilters();
}

export { savedFilters, findSavedFilter };

/* ============================================================
   SAVED FILTER UI
   The row under the search box: name a filter and save it.
   ============================================================ */

let editingFilterId = null;

export function openFilterEditor(id) {
  const f = findSavedFilter(id);
  if (!f) return;
  editingFilterId = id;
  const row = document.getElementById('filter-save-row');
  const input = document.getElementById('filter-name-input');
  row.removeAttribute('hidden');
  input.value = f.name;
  input.dataset.query = f.query;
  input.focus();
  input.select();
}

export function deleteFilter(id) {
  deleteSavedFilter(id);
  if (state.ui.view === `filter:${id}`) {
    state.ui.view = 'inbox';
    saveState();
  }
  requestRender();
  showToast('Filter deleted', 'info');
}

export function saveFilterFromRow() {
  const input = document.getElementById('filter-name-input');
  const name = input.value.trim();
  const query = input.dataset.query !== undefined ? input.dataset.query : (state.ui.search || '').trim();
  if (!name || !query) {
    showToast('A filter needs a name and a search', 'error');
    return;
  }
  const editing = editingFilterId;
  const id = editing || `filter_${uid()}`;
  upsertSavedFilter(id, name, query);
  editingFilterId = null;
  input.value = '';
  delete input.dataset.query;
  document.getElementById('filter-save-row').setAttribute('hidden', '');
  if (!editing) {
    state.ui.search = '';
    document.getElementById('search-input').value = '';
  }
  saveState();
  services.navigateTo(`filter:${id}`);
  showToast(editing ? 'Filter updated' : 'Filter saved', 'success');
}

/** Wires the "save as filter" row. */
export function initFilterEditor() {
  document.getElementById('add-filter-btn').onclick = () => {
    editingFilterId = null;
    const input = document.getElementById('filter-name-input');
    input.value = '';
    delete input.dataset.query;
    document.getElementById('filter-save-row').removeAttribute('hidden');
    input.focus();
    if (!(state.ui.search || '').trim()) {
      showToast('Type a search first, then save it as a filter', 'error');
    }
  };

  document.getElementById('filter-save-btn').onclick = saveFilterFromRow;
  document.getElementById('filter-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveFilterFromRow(); }
  });
}

const QUERY_DATE_TERMS = {
  overdue: t => isTaskOverdue(t),
  today: t => t.due === todayISO(),
  tomorrow: t => t.due === daysFromToday(1),
  yesterday: t => t.due === daysFromToday(-1),
  week: t => !!t.due && t.due >= todayISO() && t.due <= daysFromToday(7),
  month: t => !!t.due && t.due >= todayISO() && t.due <= daysFromToday(30),
};

const QUERY_RANGES = {
  day: 1, days: 1, week: 7, weeks: 7, month: 30, months: 30,
};

let queryCache = { text: null, fn: null };

export function tokenizeQuery(text) {
  const tokens = [];
  const src = String(text || '').replace(/\bnext\s+/gi, ' ');
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if ('&|!()'.includes(ch)) { tokens.push({ op: ch }); i++; continue; }

    let word = '';
    if (ch === '"') {
      i++;
      while (i < src.length && src[i] !== '"') { word += src[i]; i++; }
      i++;
    } else {
      while (i < src.length && !/[\s&|!()]/.test(src[i])) { word += src[i]; i++; }
      // "7 days" / "2 weeks" are a single term.
      if (/^\d+$/.test(word)) {
        const um = /^\s*(days|day|weeks|week|months|month)/i.exec(src.slice(i));
        if (um) { word += ' ' + um[1].toLowerCase(); i += um[0].length; }
      }
    }
    if (word) tokens.push({ word });
  }
  return tokens;
}

export function queryTermPredicate(word) {
  const w = String(word || '').trim().toLowerCase();
  if (!w) return () => true;

  if (/^p[1-4]$/.test(w)) {
    const p = Number(w[1]);
    return t => t.priority === p;
  }
  if (w.startsWith('#')) {
    const name = w.slice(1);
    return t => {
      const proj = state.projects.find(p => p.name.toLowerCase() === name);
      const wanted = proj ? proj.id : name;
      return String(t.projectId || '').toLowerCase() === wanted.toLowerCase();
    };
  }
  if (w.startsWith('@')) {
    const name = w.slice(1);
    return t => {
      const lbl = state.labels.find(l => l.name.toLowerCase() === name);
      const wanted = lbl ? lbl.id : name;
      return (t.labels || []).some(lid => String(lid).toLowerCase() === wanted.toLowerCase());
    };
  }
  if (w === 'has:date') return t => !!t.due;
  if (w === 'no:date') return t => !t.due;
  if (w === 'has:project') return t => !!t.projectId;
  if (w === 'no:project') return t => !t.projectId;
  if (w === 'has:label') return t => (t.labels || []).length > 0;
  if (w === 'no:label') return t => !(t.labels || []).length;
  if (w === 'has:priority') return t => t.priority < 4;
  if (w === 'no:priority') return t => t.priority === 4;
  if (w === 'has:reminders' || w === 'has:reminder') return t => taskReminders(t).length > 0;
  if (w === 'has:deadline') return t => !!t.deadline;
  if (w === 'no:deadline') return t => !t.deadline;
  if (w === 'has:attachment' || w === 'has:attachments') return t => (t.attachments || []).length > 0;
  if (w === '*') return () => true;

  // due:today / due:overdue / due:2026-12-31 …
  if (w.startsWith('due:')) {
    const value = w.slice(4);
    if (value === 'no' || value === 'none') return t => !t.due;
    if (QUERY_DATE_TERMS[value]) return QUERY_DATE_TERMS[value];
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return t => t.due === value;
    return t => false;
  }

  // created today / created:2026-11-01 (createdAt is a timestamp).
  if (w.startsWith('created:')) {
    const value = w.slice(8);
    const createdDay = t => t.createdAt ? toISODate(new Date(t.createdAt)) : '';
    if (value === 'today') return t => createdDay(t) === todayISO();
    if (value === 'yesterday') return t => createdDay(t) === daysFromToday(-1);
    if (value === 'week') return t => {
      const day = createdDay(t);
      return !!day && day >= daysFromToday(-7) && day <= todayISO();
    };
    if (value === 'month') return t => {
      const day = createdDay(t);
      return !!day && day >= daysFromToday(-30) && day <= todayISO();
    };
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return t => createdDay(t) === value;
    return t => false;
  }

  // search:foo matches the title/description explicitly.
  if (w.startsWith('search:')) {
    const needle = w.slice(7);
    return t => `${t.title} ${t.description || ''}`.toLowerCase().includes(needle);
  }

  const range = /^(\d+)\s*(days|day|weeks|week|months|month)$/.exec(w);
  if (range) {
    const days = QUERY_RANGES[range[2]] * Number(range[1]);
    return t => !!t.due && t.due >= todayISO() && t.due <= daysFromToday(days);
  }
  if (QUERY_DATE_TERMS[w]) return QUERY_DATE_TERMS[w];
  if (QUERY_WEEKDAYS.includes(w)) {
    const target = nextWeekdayISO(w);
    return t => t.due === target;
  }
  return t => `${t.title} ${t.description || ''}`.toLowerCase().includes(w);
}

/** Parses a query into a predicate. | = or, & / spaces = and, ! = not. */
export function parseQuery(text) {
  const tokens = tokenizeQuery(text);
  let pos = 0;
  const peek = () => tokens[pos];

  function parseOr() {
    let left = parseAnd();
    while (peek() && peek().op === '|') {
      pos++;
      const right = parseAnd();
      const l = left;
      left = t => l(t) || right(t);
    }
    return left;
  }
  function parseAnd() {
    let left = parseUnary();
    while (peek() && (peek().word || peek().op === '&' || peek().op === '!')) {
      if (peek().op === '&') pos++;
      const right = parseUnary();
      const l = left;
      left = t => l(t) && right(t);
    }
    return left;
  }
  function parseUnary() {
    if (peek() && peek().op === '!') {
      pos++;
      const inner = parseUnary();
      return t => !inner(t);
    }
    return parseTerm();
  }
  function parseTerm() {
    const tok = peek();
    if (!tok) return () => true;
    if (tok.op === '(') {
      pos++;
      const inner = parseOr();
      if (peek() && peek().op === ')') pos++;
      return inner;
    }
    if (tok.op === ')') { pos++; return () => true; }
    pos++;
    return queryTermPredicate(tok.word || '');
  }
  if (!tokens.length) return () => true;
  return parseOr();
}

export function queryMatcher(text) {
  const key = String(text || '');
  if (queryCache.text === key) return queryCache.fn;
  queryCache = { text: key, fn: parseQuery(key) };
  return queryCache.fn;
}
