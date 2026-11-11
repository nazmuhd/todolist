/**
 * The list view: the main column of the app.
 *
 * It renders the task list for whichever view is active, and groups the
 * tasks for the views that group them (upcoming, today, completed, a
 * project with sections).
 */
import { state, saveState } from '../core/state.js';
import { activeTasks, completedTasks } from '../core/tasks.js';
import { parseDate, toISODate, todayISO, daysFromToday, formatDateShort, isTaskOverdue, dueSortValue } from '../core/dates.js';
import { escapeHtml } from '../core/text.js';
import { queryMatcher, savedFilters } from '../features/filters.js';
import { showEmptyState } from '../features/empty-states.js';
import { renderTaskRow, bindTaskEvents } from '../features/task-row.js';
import { renderCalendar } from '../features/calendar.js';
import { renderKarma } from '../features/karma.js';
import { renderBoard, destroyBoardSortables } from './board.js';

/** Board layout is available for task lists, not grouped/archive views. */
export function supportsBoard(view = state.ui.view) {
  return view !== 'upcoming' && view !== 'completed' && view !== 'calendar' && view !== 'karma' && !(state.ui.search || '').trim();
}

const SORT_OPTIONS = [
  { id: 'manual', label: 'Manual order' },
  { id: 'date', label: 'Due date' },
  { id: 'priority', label: 'Priority' },
  { id: 'name', label: 'Name (A–Z)' },
  { id: 'added', label: 'Date added' },
];

export function sortTasks(tasks) {
  const sort = state.ui.sort || 'manual';
  const arr = [...tasks];
  if (sort === 'date') {
    arr.sort((a, b) => dueSortValue(a) - dueSortValue(b) || a.order - b.order);
  } else if (sort === 'priority') {
    arr.sort((a, b) => (a.priority - b.priority) || (a.order - b.order));
  } else if (sort === 'name') {
    arr.sort((a, b) => a.title.localeCompare(b.title) || (a.order - b.order));
  } else if (sort === 'added') {
    arr.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  } else {
    arr.sort((a, b) => a.order - b.order);
  }
  return arr;
}

/** The title, icon and task filter of the active view. */
export function getViewInfo() {
  const v = state.ui.view;
  const search = (state.ui.search || '').trim().toLowerCase();

  let title = 'Inbox', icon = 'inbox', subtitle = '', filter = () => true;

  if (search) {
    title = `Search: "${state.ui.search}"`;
    icon = 'search';
    subtitle = '';
    const match = queryMatcher(state.ui.search);
    filter = (t) => match(t);
  } else if (v.startsWith('filter:')) {
    const id = v.slice(7);
    const saved = savedFilters.find(f => f.id === id);
    title = saved ? saved.name : 'Filter';
    icon = 'filter';
    subtitle = saved ? saved.query : '';
    const match = saved ? queryMatcher(saved.query) : () => false;
    filter = (t) => match(t);
  } else if (v === 'inbox') {
    title = 'Inbox'; icon = 'inbox';
    subtitle = 'Tasks with no project';
    filter = (t) => !t.projectId;
  } else if (v === 'today') {
    title = 'Today'; icon = 'calendar-days';
    subtitle = new Intl.DateTimeFormat('en', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());
    filter = (t) => t.due === todayISO() || isTaskOverdue(t);
  } else if (v === 'upcoming') {
    title = 'Upcoming'; icon = 'calendar';
    subtitle = '';
    filter = (t) => !!t.due;
  } else if (v === 'calendar') {
    title = 'Calendar'; icon = 'calendar-days';
    subtitle = '';
    filter = (t) => !!t.due;
  } else if (v === 'karma') {
    title = 'Karma'; icon = 'trophy';
    subtitle = 'Your productivity at a glance';
    filter = () => true;
  } else if (v === 'completed') {
    title = 'Completed'; icon = 'circle-check-big';
    subtitle = '';
    filter = (t) => !!t.completed;
  } else if (v === 'no-date') {
    title = 'No date'; icon = 'calendar-x';
    subtitle = 'Tasks without a due date';
    filter = (t) => !t.due;
  } else if (v === 'no-priority') {
    title = 'No priority'; icon = 'flag-off';
    subtitle = 'Tasks still at Priority 4';
    filter = (t) => t.priority === 4;
  } else if (v.startsWith('project:')) {
    const id = v.split(':')[1];
    const proj = state.projects.find(p => p.id === id);
    title = proj ? proj.name : 'Project';
    icon = 'hash';
    subtitle = '';
    filter = (t) => t.projectId === id;
  } else if (v.startsWith('label:')) {
    const id = v.split(':')[1];
    const lbl = state.labels.find(l => l.id === id);
    title = lbl ? `@${lbl.name}` : 'Label';
    icon = 'tag';
    subtitle = '';
    filter = (t) => (t.labels || []).includes(id);
  }
  return { title, icon, subtitle, filter };
}

export function renderMain() {
  const info = getViewInfo();
  document.getElementById('view-title-text').textContent = info.title;
  document.getElementById('view-icon').setAttribute('data-lucide', info.icon);
  document.getElementById('view-subtitle').textContent = info.subtitle;
  updateLayoutToggle();

  const list = document.getElementById('task-list');
  const board = document.getElementById('board-view');
  const searchActive = !!(state.ui.search || '').trim();

  // Reset whichever content mode was shown last.
  list.classList.remove('hidden');
  list.innerHTML = '';
  destroyBoardSortables();
  board.classList.add('hidden');
  board.innerHTML = '';
  document.getElementById('calendar-view').classList.add('hidden');
  document.getElementById('calendar-view').innerHTML = '';
  document.getElementById('karma-view').classList.add('hidden');
  document.getElementById('karma-view').innerHTML = '';
  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('content-container').classList.remove('board-mode');
  document.getElementById('content-container').classList.remove('calendar-mode');

  // Upcoming gets day buckets instead of one flat list (no drag reorder).
  if (state.ui.view === 'upcoming' && !searchActive) {
    renderUpcoming(list);
    return;
  }
  if (state.ui.view === 'calendar' && !searchActive) {
    list.classList.add('hidden');
    document.getElementById('calendar-view').classList.remove('hidden');
    document.getElementById('content-container').classList.add('calendar-mode');
    renderCalendar();
    return;
  }
  if (state.ui.view === 'karma' && !searchActive) {
    list.classList.add('hidden');
    document.getElementById('karma-view').classList.remove('hidden');
    renderKarma();
    return;
  }
  if (state.ui.view === 'completed' && !searchActive) {
    renderCompleted(list);
    return;
  }
  // Today keeps overdue tasks separate from today's own list, so it is
  // grouped (and not drag-ordered) like Upcoming.
  if (state.ui.view === 'today' && !searchActive && state.ui.layout !== 'board') {
    renderToday(list);
    return;
  }
  if (!searchActive && state.ui.layout === 'board' && supportsBoard()) {
    renderBoard(info);
    return;
  }

  // A project with sections groups its tasks under section headers.
  if (state.ui.view.startsWith('project:') && !searchActive) {
    const proj = state.projects.find(p => p.id === state.ui.view.slice(8));
    if (proj && Array.isArray(proj.sections) && proj.sections.length) {
      renderProjectSectionsView(list);
      return;
    }
  }

  // Normal list views hide completed tasks; the Completed view is their home.
  // Completed matches sort last but keep the chosen order otherwise.
  const visible = sortTasks(
    activeTasks()
      .filter(info.filter)
      .filter(t => searchActive || !t.completed)
  ).sort((a, b) => a.completed - b.completed);
  if (!visible.length) {
    // Each view brings its own copy and artwork.
    if (state.ui.search) showEmptyState('', '', false);
    else showEmptyState();
    return;
  }

  list.innerHTML = visible.map(t => renderTaskRow(t, false)).join('');
  bindTaskEvents(true);
}

/** Shows the list/board switch only where a board makes sense. */
export function updateLayoutToggle() {
  const wrap = document.getElementById('view-layout');
  const show = supportsBoard();
  wrap.classList.toggle('hidden', !show);
  if (!show) return;
  wrap.querySelectorAll('[data-layout]').forEach(btn => {
    const active = btn.dataset.layout === (state.ui.layout === 'board' ? 'board' : 'list');
    btn.classList.toggle('layout-btn-active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
}

/** Upcoming: Overdue first, then one section per calendar day. */
export function upcomingGroups() {
  const today = todayISO();
  const tomorrowDate = parseDate(today);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrow = toISODate(tomorrowDate);

  const tasks = activeTasks()
    .filter(t => t.due && !t.completed)
    .sort((a, b) => dueSortValue(a) - dueSortValue(b) || a.order - b.order);

  const groups = [];
  const overdue = tasks.filter(t => t.due < today);
  if (overdue.length) groups.push({ key: 'overdue', label: 'Overdue', tasks: overdue });

  const byDay = new Map();
  tasks.filter(t => t.due >= today).forEach(t => {
    if (!byDay.has(t.due)) byDay.set(t.due, []);
    byDay.get(t.due).push(t);
  });

  [...byDay.keys()].sort().forEach(day => {
    const label = day === today ? 'Today'
      : day === tomorrow ? 'Tomorrow'
      : new Intl.DateTimeFormat('en', { weekday: 'long', month: 'short', day: 'numeric' }).format(parseDate(day));
    groups.push({ key: day, label, tasks: byDay.get(day) });
  });
  return groups;
}

export function renderUpcoming(list) {
  const groups = upcomingGroups();
  if (!groups.length) {
    list.innerHTML = '';
    showEmptyState();
    return;
  }
  document.getElementById('empty-state').classList.add('hidden');
  list.innerHTML = groups.map(g => `
    <li class="day-group-header" data-day-group="${g.key}">
      <span>${escapeHtml(g.label)}</span>
      <span class="text-td-muted font-normal">${g.tasks.length}</span>
    </li>
    ${g.tasks.map(t => renderTaskRow(t, false)).join('')}
  `).join('');
  // Grouped order is date order, so drag reordering is disabled here.
  bindTaskEvents(false);
}

/**
 * Today: overdue work first (its own group), then the tasks due today.
 * A task due earlier today counts as overdue once its time has passed.
 */
export function todayGroups() {
  const today = todayISO();
  const tasks = activeTasks()
    .filter(t => t.due && !t.completed)
    .filter(t => t.due === today || isTaskOverdue(t))
    .sort((a, b) => dueSortValue(a) - dueSortValue(b) || a.order - b.order);

  const groups = [];
  const overdue = tasks.filter(t => isTaskOverdue(t));
  if (overdue.length) groups.push({ key: 'overdue', label: 'Overdue', tasks: overdue });

  const dueToday = tasks.filter(t => !isTaskOverdue(t));
  if (dueToday.length) groups.push({ key: 'today', label: '', tasks: dueToday });
  return groups;
}

export function renderToday(list) {
  const groups = todayGroups();
  if (!groups.length) {
    list.innerHTML = '';
    showEmptyState();
    return;
  }
  document.getElementById('empty-state').classList.add('hidden');
  list.innerHTML = groups.map(g => `
    ${g.label ? `
    <li class="day-group-header" data-day-group="${g.key}">
      <span>${escapeHtml(g.label)}</span>
      <span class="text-td-muted font-normal">${g.tasks.length}</span>
    </li>` : ''}
    ${g.tasks.map(t => renderTaskRow(t, false)).join('')}
  `).join('');
  // Grouped order is date order, so drag reordering is disabled here.
  bindTaskEvents(false);
}

/** A project with sections groups its tasks under section headers. */
let projectSectionFilter = null;

export function renderProjectSectionsView(list) {
  const projId = state.ui.view.slice(8);
  const proj = state.projects.find(p => p.id === projId);
  const sections = proj && Array.isArray(proj.sections) ? proj.sections : [];
  const tasks = activeTasks()
    .filter(t => t.projectId === projId && !t.completed)
    .sort((a, b) => a.order - b.order);

  // A filter that belongs to another project (or a removed section) resets.
  if (projectSectionFilter && !sections.some(s => s.id === projectSectionFilter)) {
    projectSectionFilter = null;
  }
  const visible = projectSectionFilter
    ? tasks.filter(t => t.sectionId === projectSectionFilter)
    : tasks;

  const groups = sections
    .map(s => ({ key: s.id, label: s.name, tasks: visible.filter(t => t.sectionId === s.id) }))
    .filter(g => g.tasks.length);
  const ungrouped = visible.filter(t => !t.sectionId || !sections.some(s => s.id === t.sectionId));
  if (ungrouped.length && !projectSectionFilter) groups.push({ key: '', label: 'No section', tasks: ungrouped });

  if (!groups.length) {
    list.innerHTML = '';
    showEmptyState();
    return;
  }
  document.getElementById('empty-state').classList.add('hidden');
  list.innerHTML = `
    <li class="flex flex-wrap items-center gap-1 mb-3 list-none">
      <button type="button" class="qa-pick" data-section-filter="" aria-pressed="${!projectSectionFilter}">All</button>
      ${sections.map(s => `
        <button type="button" class="qa-pick" data-section-filter="${escapeHtml(s.id)}" aria-pressed="${projectSectionFilter === s.id}">
          ${escapeHtml(s.name)}
        </button>`).join('')}
    </li>
    ${groups.map(g => `
    <li class="day-group-header" data-day-group="${escapeHtml(g.key)}">
      <span>${escapeHtml(g.label)}</span>
      <span class="text-td-muted font-normal">${g.tasks.length}</span>
    </li>
    ${g.tasks.map(t => renderTaskRow(t, false)).join('')}`).join('')}`;
  bindTaskEvents(false);
}

/** "Earlier" covers completed tasks from older data with no timestamp. */
export function completionDayKey(ts) {
  return ts ? toISODate(new Date(ts)) : 'earlier';
}

export function completionDayLabel(key) {
  if (key === 'earlier') return 'Earlier';
  const today = parseDate(todayISO());
  const day = parseDate(key);
  const diff = Math.round((today - day) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  const weekday = new Intl.DateTimeFormat('en', { weekday: 'long' }).format(day);
  const label = formatDateShort(day, { year: day.getFullYear() !== today.getFullYear() });
  return `${weekday}, ${label}`;
}

/** Completed: newest first, one section per completion day, subtasks included. */
export function renderCompleted(list) {
  const tasks = completedTasks();
  if (!tasks.length) {
    showEmptyState('', '', false);
    return;
  }
  document.getElementById('empty-state').classList.add('hidden');

  const groups = new Map();
  tasks.forEach(t => {
    const key = completionDayKey(t.completedAt);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  });
  const keys = [...groups.keys()].sort((a, b) => {
    if (a === 'earlier') return 1;
    if (b === 'earlier') return -1;
    return b.localeCompare(a);
  });

  list.innerHTML = keys.map(key => `
    <li class="day-group-header" data-day-group="${key}">
      <span>${escapeHtml(completionDayLabel(key))}</span>
      <span class="text-td-muted font-normal">${groups.get(key).length}</span>
    </li>
    ${groups.get(key).map(t => renderTaskRow(t, !!t.parentId, {
      parentTitle: t.parentId ? state.tasks.find(p => p.id === t.parentId)?.title : '',
      noSubtasks: true,
    })).join('')}
  `).join('');
  // Completion dates define the order, so drag reordering is disabled here.
  bindTaskEvents(false);
}

/** The sort menu in the header. */
export function renderSortMenu() {
  const menu = document.getElementById('sort-menu');
  menu.innerHTML = SORT_OPTIONS.map(o => `
    <button type="button" data-sort="${o.id}" class="w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center gap-2 ${state.ui.sort === o.id ? 'text-td-red font-medium' : ''}">
      <i data-lucide="check" class="w-3.5 h-3.5 ${state.ui.sort === o.id ? '' : 'invisible'}"></i>${o.label}
    </button>`).join('');
}

/** Section filter chips in the project view. */
export function initListView(onSectionFilter) {
  document.getElementById('task-list').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-section-filter]');
    if (!chip) return;
    e.preventDefault();
    e.stopPropagation();
    projectSectionFilter = chip.dataset.sectionFilter || null;
    onSectionFilter();
  });
}
