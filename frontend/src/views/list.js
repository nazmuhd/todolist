/**
 * The list view: the main column of the app.
 *
 * It renders the task list for whichever view is active, and groups the
 * tasks for the views that group them (upcoming, today, completed, a
 * project with sections).
 */
import { state, saveState } from '../core/state.js';
import { activeTasks, completedTasks } from '../core/tasks.js';
import { requestRender } from '../core/render.js';
import { parseDate, toISODate, todayISO, daysFromToday, formatDateShort, isTaskOverdue, dueSortValue } from '../core/dates.js';
import { escapeHtml } from '../core/text.js';
import { queryMatcher, savedFilters, filterViewSections } from '../features/filters.js';
import { showEmptyState } from '../features/empty-states.js';
import { renderTaskRow, bindTaskEvents } from '../features/task-row.js';
import { renderCalendar } from '../features/calendar.js';
import { renderKarma } from '../features/karma.js';
import { renderActivity } from './activity.js';
import { renderBoard, destroyBoardSortables } from './board.js';
import { renderTable } from './table.js';
import { hasNoPriority } from '../core/priorities.js';
import { setSectionArchived, deleteSection, duplicateSection, moveSection } from '../features/projects.js';
import { services } from '../core/services.js';
import { showToast } from '../core/toasts.js';

function contextualQuickAddDefaults() {
  const v = state.ui.view || 'inbox';
  const defaults = {};
  if (v === 'today') defaults.due = todayISO();
  else if (v.startsWith('project:')) defaults.projectId = v.slice(8);
  else if (v.startsWith('label:')) defaults.labels = [v.slice(6)];
  return defaults;
}

function inlineAddTaskRow(defaults = {}) {
  const payload = encodeURIComponent(JSON.stringify(defaults || {}));
  return `
    <li class="list-none mt-1">
      <button type="button" class="inline-add-task-btn flex items-center gap-2 w-full text-left text-sm text-td-muted hover:text-td-red px-2 py-1.5 rounded hover:bg-gray-50" data-inline-add-task="${payload}">
        <span class="inline-flex items-center justify-center w-4 h-4 text-td-red"><i data-lucide="plus" class="w-3.5 h-3.5"></i></span>
        <span>Add task</span>
      </button>
    </li>`;
}

function isMultiSectionFilterView(view = state.ui.view) {
  if (typeof view !== 'string' || !view.startsWith('filter:')) return false;
  const saved = savedFilters.find(f => f.id === view.slice(7));
  return saved ? filterViewSections(saved.query).length > 1 : false;
}

/** Board layout is available for task lists, not grouped/archive views. */
export function supportsBoard(view = state.ui.view) {
  return view !== 'upcoming' && view !== 'completed' && view !== 'calendar' && view !== 'karma' && view !== 'activity' && !(state.ui.search || '').trim() && !isMultiSectionFilterView(view);
}

/**
 * The table layout needs a flat list of tasks, so it is offered wherever the
 * board is (both are task lists) but not for the grouped views.
 */
export function supportsTable(view = state.ui.view) {
  return supportsBoard(view);
}

const SORT_OPTIONS = [  { id: 'manual', label: 'Manual order' },
  { id: 'date', label: 'Due date' },
  { id: 'priority', label: 'Priority' },
  { id: 'name', label: 'Name (A–Z)' },
  { id: 'added', label: 'Date added' },
];

/** Large lists render in pages; the button at the end reveals the next one. */
const PAGE_SIZE = 100;
let visibleLimit = PAGE_SIZE;
let lastViewSignature = '';

function loadMoreRow(remaining) {
  return `<li class="list-none mt-3"><button type="button" class="qa-pick w-full" data-load-more>Show ${remaining} more</button></li>`;
}

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
    title = 'Today'; icon = 'calendar-check';
    subtitle = new Intl.DateTimeFormat('en', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());
    filter = (t) => t.due === todayISO() || isTaskOverdue(t);
  } else if (v === 'upcoming') {
    title = 'Upcoming'; icon = 'calendar-days';
    subtitle = '';
    filter = (t) => !!t.due;
  } else if (v === 'calendar') {
    title = 'Calendar'; icon = 'calendar-range';
    subtitle = '';
    filter = (t) => !!t.due;
  } else if (v === 'karma') {
    title = 'Productivity'; icon = 'chart-column-increasing';
    subtitle = 'Your completed-task trends and streaks';
    filter = () => true;
  } else if (v === 'activity') {
    title = 'Activity'; icon = 'history';
    subtitle = 'A history of changes to your tasks';
    filter = () => true;
  } else if (v === 'completed') {
    title = 'Completed'; icon = 'circle-check-big';
    subtitle = 'Completed tasks, grouped by completion day';
    filter = (t) => !!t.completed;
  } else if (v === 'no-date') {
    title = 'No date'; icon = 'calendar-x';
    subtitle = 'Tasks without a due date';
    filter = (t) => !t.due;
  } else if (v === 'no-priority') {
    title = 'No priority'; icon = 'flag-off';
    subtitle = 'Tasks still at Priority 4';
    filter = (t) => hasNoPriority(t);
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

  // Changing view, search, sort or layout starts a fresh page.
  const signature = [state.ui.view, state.ui.search || '', state.ui.sort || '', state.ui.layout || 'list'].join('|');
  if (signature !== lastViewSignature) {
    lastViewSignature = signature;
    visibleLimit = PAGE_SIZE;
  }

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
  document.getElementById('activity-view').classList.add('hidden');
  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('loading-skeleton')?.classList.add('hidden');
  document.getElementById('content-container').classList.remove('board-mode');
  document.getElementById('content-container').classList.remove('calendar-mode');
  document.getElementById('content-container').classList.remove('table-mode');

  // Upcoming gets day buckets instead of one flat list (no drag reorder).
  if (state.ui.view === 'upcoming' && !searchActive) {
    renderUpcoming(list);
    if (!list.innerHTML.trim() && document.getElementById('empty-state').classList.contains('hidden')) {
      list.innerHTML = inlineAddTaskRow(contextualQuickAddDefaults());
      showEmptyState('', '', false);
    }
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
  if (state.ui.view === 'activity' && !searchActive) {
    list.classList.add('hidden');
    document.getElementById('activity-view').classList.remove('hidden');
    renderActivity(document.getElementById('activity-view'));
    return;
  }
  if (state.ui.view === 'completed' && !searchActive) {
    renderCompleted(list);
    return;
  }
  // Today keeps overdue tasks separate from today's own list, so it is
  // grouped (and not drag-ordered) like Upcoming. The table layout is a
  // flat list, so it is used there too.
  if (state.ui.view === 'today' && !searchActive && state.ui.layout === 'list') {
    renderToday(list);
    if (!list.querySelector('[data-task-id]')) {
      try {
        const fallbackTasks = sortTasks(
          activeTasks().filter(info.filter).filter(t => !t.completed)
        ).sort((a, b) => a.completed - b.completed);
        if (fallbackTasks.length) {
          document.getElementById('empty-state').classList.add('hidden');
          list.innerHTML = fallbackTasks.map(t => renderTaskRow(t, false)).join('')
            + inlineAddTaskRow({ due: todayISO() });
          bindTaskEvents(false);
          return;
        }
      } catch (err) {
        console.error('today flat fallback failed', err);
      }
    }
    if (!list.innerHTML.trim() && document.getElementById('empty-state').classList.contains('hidden')) {
      list.innerHTML = inlineAddTaskRow({ due: todayISO() });
      showEmptyState('', '', false);
    }
    return;
  }
  if (!searchActive && state.ui.layout === 'table' && supportsTable()) {
    document.getElementById('content-container').classList.add('table-mode');
    renderTable(info);
    return;
  }
  if (!searchActive && state.ui.layout === 'board' && supportsBoard()) {
    renderBoard(info);
    return;
  }

  // A project with sections groups its tasks under section headers.
  if (state.ui.view.startsWith('project:') && !searchActive) {
    const proj = state.projects.find(p => p.id === state.ui.view.slice(8));
    const hasActiveSections = !!(proj && Array.isArray(proj.sections) && proj.sections.some(s => !s.archived));
    if (hasActiveSections) {
      renderProjectSectionsView(list);
      if (!list.querySelector('[data-task-id]')) {
        try {
          const fallbackTasks = sortTasks(
            activeTasks().filter(info.filter).filter(t => !t.completed)
          ).sort((a, b) => a.completed - b.completed);
          if (fallbackTasks.length) {
            document.getElementById('empty-state').classList.add('hidden');
            list.innerHTML = fallbackTasks.map(t => renderTaskRow(t, false)).join('')
              + inlineAddTaskRow({ projectId: proj?.id || null, sectionId: null });
            bindTaskEvents(true);
            return;
          }
        } catch (err) {
          console.error('project flat fallback failed', err);
        }
      }
      if (!list.innerHTML.trim() && document.getElementById('empty-state').classList.contains('hidden')) {
        list.innerHTML = inlineAddTaskRow({ projectId: proj?.id || null, sectionId: null });
        showEmptyState('', '', false);
      }
      return;
    }
  }

  // Saved filters with comma-separated queries render as stacked sections.
  if (state.ui.view.startsWith('filter:') && !searchActive) {
    const saved = savedFilters.find(f => f.id === state.ui.view.slice(7));
    const sections = saved ? filterViewSections(saved.query) : [];
    if (sections.length > 1) {
      const used = new Set();
      const html = sections.map((sec, idx) => {
        const tasks = sortTasks(activeTasks().filter(sec.match).filter(t => !t.completed && !used.has(t.id)));
        tasks.forEach(t => used.add(t.id));
        return `
          <li class="day-group-header" data-filter-section="${idx}">
            <span>${escapeHtml(sec.query || `Section ${idx + 1}`)}</span>
            <span class="text-td-muted font-normal">${tasks.length}</span>
          </li>
          ${tasks.map(t => renderTaskRow(t, false)).join('')}`;
      }).join('');
      if (!used.size) {
        list.innerHTML = inlineAddTaskRow(contextualQuickAddDefaults());
        showEmptyState();
        bindTaskEvents(false);
        return;
      }
      list.innerHTML = html;
      bindTaskEvents(false);
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
    list.innerHTML = searchActive ? '' : inlineAddTaskRow(contextualQuickAddDefaults());
    // Each view brings its own copy and artwork.
    if (state.ui.search) showEmptyState('', '', false);
    else showEmptyState();
    if (!searchActive) bindTaskEvents(true);
    return;
  }

  try {
    const page = visible.slice(0, visibleLimit);
    list.innerHTML = page.map(t => renderTaskRow(t, false)).join('')
      + (visible.length > page.length ? loadMoreRow(visible.length - page.length) : '')
      + inlineAddTaskRow(contextualQuickAddDefaults());
    bindTaskEvents(true);
  } catch (err) {
    console.error('renderMain list failed', err);
    list.innerHTML = inlineAddTaskRow(contextualQuickAddDefaults());
    showEmptyState('', '', false);
  }

  if (!list.innerHTML.trim() && document.getElementById('empty-state').classList.contains('hidden')) {
    const special = ['calendar', 'karma', 'activity'].includes(state.ui.view);
    if (!special) {
      list.innerHTML = searchActive ? '' : inlineAddTaskRow(contextualQuickAddDefaults());
      if (!searchActive) showEmptyState('', '', false);
    }
  }
}

/** Shows the list/board/table switch only where a layout makes sense. */
export function updateLayoutToggle() {
  const wrap = document.getElementById('view-layout');
  const show = supportsBoard();
  wrap.classList.toggle('hidden', !show);
  if (!show) return;
  const current = state.ui.layout === 'board' ? 'board' : state.ui.layout === 'table' ? 'table' : 'list';
  wrap.querySelectorAll('[data-layout]').forEach(btn => {
    const active = btn.dataset.layout === current;
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
  if (overdue.length) groups.push({ key: 'overdue', label: 'Overdue', tasks: overdue, due: null });

  const byDay = new Map();
  tasks.filter(t => t.due >= today).forEach(t => {
    if (!byDay.has(t.due)) byDay.set(t.due, []);
    byDay.get(t.due).push(t);
  });

  [...byDay.keys()].sort().forEach(day => {
    const label = day === today ? 'Today'
      : day === tomorrow ? 'Tomorrow'
      : new Intl.DateTimeFormat('en', { weekday: 'long', month: 'short', day: 'numeric' }).format(parseDate(day));
    groups.push({ key: day, label, tasks: byDay.get(day), due: day });
  });
  return groups;
}

export function renderUpcoming(list) {
  const groups = upcomingGroups();
  if (!groups.length) {
    list.innerHTML = inlineAddTaskRow(contextualQuickAddDefaults());
    showEmptyState();
    bindTaskEvents(false);
    return;
  }
  document.getElementById('empty-state').classList.add('hidden');
  list.innerHTML = groups.map(g => `
    <li class="day-group-header" data-day-group="${g.key}" title="Drop a task here to reschedule it">
      <span>${escapeHtml(g.label)}</span>
      <span class="text-td-muted font-normal">${g.tasks.length}</span>
    </li>
    ${g.tasks.map(t => renderTaskRow(t, false, { draggable: true })).join('')}
    ${g.due ? inlineAddTaskRow({ due: g.due }) : ''}
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
  if (overdue.length) groups.push({ key: 'overdue', label: 'Overdue', tasks: overdue, due: today });

  const dueToday = tasks.filter(t => !isTaskOverdue(t));
  if (dueToday.length) groups.push({ key: 'today', label: '', tasks: dueToday, due: today });
  return groups;
}

export function renderToday(list) {
  try {
    const groups = todayGroups();
    if (!groups.length) {
      list.innerHTML = inlineAddTaskRow({ due: todayISO() });
      showEmptyState();
      bindTaskEvents(false);
      return;
    }
    document.getElementById('empty-state').classList.add('hidden');
    list.innerHTML = groups.map(g => `
      ${g.label ? `
      <li class="day-group-header" data-day-group="${g.key}" title="Drop a task here to reschedule it">
        <span>${escapeHtml(g.label)}</span>
        <span class="text-td-muted font-normal">${g.tasks.length}</span>
      </li>` : ''}
      ${g.tasks.map(t => renderTaskRow(t, false, { draggable: true })).join('')}
      ${inlineAddTaskRow({ due: g.due || todayISO() })}
    `).join('');
    // Grouped order is date order, so drag reordering is disabled here.
    bindTaskEvents(false);
  } catch (err) {
    console.error('renderToday failed', err);
    list.innerHTML = inlineAddTaskRow({ due: todayISO() });
    showEmptyState('', '', false);
  }
}

/** A project with sections groups its tasks under section headers. */
let projectSectionFilter = null;

export function renderProjectSectionsView(list) {
  try {
  const projId = state.ui.view.slice(8);
  const proj = state.projects.find(p => p.id === projId);
  const sections = proj && Array.isArray(proj.sections) ? proj.sections : [];
  const activeSections = sections.filter(s => !s.archived);
  const archivedSectionIds = new Set(sections.filter(s => s.archived).map(s => s.id));
  const tasks = activeTasks()
    .filter(t => t.projectId === projId && !t.completed && !archivedSectionIds.has(t.sectionId))
    .sort((a, b) => a.order - b.order);

  if (projectSectionFilter && !activeSections.some(s => s.id === projectSectionFilter)) {
    projectSectionFilter = null;
  }
  const visible = projectSectionFilter
    ? tasks.filter(t => t.sectionId === projectSectionFilter)
    : tasks;

  const collapsed = (state.ui.collapsedProjectSections && typeof state.ui.collapsedProjectSections === 'object') ? state.ui.collapsedProjectSections : {};
  const groups = activeSections
    .map(s => ({ key: s.id, label: s.name, tasks: visible.filter(t => t.sectionId === s.id), archived: !!s.archived }))
    .filter(g => g.tasks.length || (projectSectionFilter === g.key));
  const ungrouped = visible.filter(t => !t.sectionId || !activeSections.some(s => s.id === t.sectionId));
  if (ungrouped.length && !projectSectionFilter) groups.push({ key: '', label: 'No section', tasks: ungrouped, archived: false, noMenu: true });

  const archivedSections = sections.filter(s => s.archived);

  if (!groups.length && !archivedSections.length) {
    list.innerHTML = `
      <li class="flex flex-wrap items-center gap-1 mb-3 list-none">
        <button type="button" class="qa-pick" data-section-filter="" aria-pressed="true">All</button>
        ${activeSections.map(s => `
          <button type="button" class="qa-pick" data-section-filter="${escapeHtml(s.id)}" aria-pressed="${projectSectionFilter === s.id}">
            ${escapeHtml(s.name)}
          </button>`).join('')}
      </li>
      ${inlineAddTaskRow({ projectId: projId, sectionId: null })}`;
    showEmptyState();
    bindTaskEvents(false);
    return;
  }
  document.getElementById('empty-state').classList.add('hidden');
  const sectionMenu = (sectionId, label) => sectionId ? `
    <div class="relative ml-1">
      <button type="button" class="p-0.5 rounded text-td-muted hover:text-td-text hover:bg-gray-100" data-section-menu="${escapeHtml(sectionId)}" title="Section actions" aria-label="Section actions">
        <i data-lucide="more-horizontal" class="w-4 h-4"></i>
      </button>
      <div class="hidden absolute right-0 top-full mt-1 z-20 w-52 bg-white border border-td-border rounded-lg shadow-lg py-1 text-sm" data-section-menu-panel="${escapeHtml(sectionId)}">
        <button type="button" class="w-full text-left px-3 py-1.5 hover:bg-gray-50" data-section-action="move" data-section-id="${escapeHtml(sectionId)}">Move section to project</button>
        <button type="button" class="w-full text-left px-3 py-1.5 hover:bg-gray-50" data-section-action="duplicate" data-section-id="${escapeHtml(sectionId)}">Duplicate section</button>
        <button type="button" class="w-full text-left px-3 py-1.5 hover:bg-gray-50" data-section-action="archive" data-section-id="${escapeHtml(sectionId)}">Archive section</button>
        <button type="button" class="w-full text-left px-3 py-1.5 hover:bg-gray-50 text-red-600" data-section-action="delete" data-section-id="${escapeHtml(sectionId)}">Delete section</button>
      </div>
    </div>` : '';

  const archivedBlock = archivedSections.length ? `
    <li class="mt-4 mb-1 text-xs font-semibold text-td-muted px-1 list-none">Archived sections</li>
    ${archivedSections.map(s => `
      <li class="flex items-center justify-between gap-2 px-2 py-1.5 rounded hover:bg-gray-50 text-sm list-none">
        <span class="truncate">${escapeHtml(s.name)}</span>
        <div class="flex items-center gap-2">
          <button type="button" class="text-xs text-td-muted hover:text-td-text" data-section-action="unarchive" data-section-id="${escapeHtml(s.id)}">Unarchive</button>
          <button type="button" class="text-xs text-red-600 hover:text-red-700" data-section-action="delete" data-section-id="${escapeHtml(s.id)}">Delete</button>
        </div>
      </li>`).join('')}` : '';

  list.innerHTML = `
    <li class="flex flex-wrap items-center gap-1 mb-3 list-none">
      <button type="button" class="qa-pick" data-section-filter="" aria-pressed="${!projectSectionFilter}">All</button>
      ${activeSections.map(s => `
        <button type="button" class="qa-pick" data-section-filter="${escapeHtml(s.id)}" aria-pressed="${projectSectionFilter === s.id}">
          ${escapeHtml(s.name)}
        </button>`).join('')}
    </li>
    ${groups.map(g => {
      const isCollapsed = !!g.key && !!collapsed[g.key];
      return `
    <li class="day-group-header group/section" data-day-group="${escapeHtml(g.key)}" data-project-section-header="${escapeHtml(g.key)}">
      <button type="button" class="flex items-center gap-1 min-w-0 flex-1 text-left" data-section-toggle="${escapeHtml(g.key)}" ${g.key ? '' : 'disabled'} title="${g.key ? 'Collapse/expand section' : ''}">
        ${g.key ? `<i data-lucide="${isCollapsed ? 'chevron-right' : 'chevron-down'}" class="w-4 h-4 text-td-muted flex-shrink-0"></i>` : ''}
        <span class="truncate">${escapeHtml(g.label)}</span>
      </button>
      <span class="text-td-muted font-normal">${g.tasks.length}</span>
      ${!g.noMenu ? sectionMenu(g.key, g.label) : ''}
    </li>
    ${(!g.key || !isCollapsed) ? g.tasks.map(t => renderTaskRow(t, false)).join('') : ''}
    ${(!g.key || !isCollapsed) ? inlineAddTaskRow({ projectId: projId, sectionId: g.key || null }) : ''}`;
    }).join('')}
    ${archivedBlock}`;
  bindTaskEvents(false);
  } catch (err) {
    console.error('renderProjectSectionsView failed', err);
    const projId2 = String(state.ui.view || '').startsWith('project:') ? state.ui.view.slice(8) : null;
    list.innerHTML = inlineAddTaskRow(projId2 ? { projectId: projId2, sectionId: null } : {});
    showEmptyState('', '', false);
  }
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

  const page = tasks.slice(0, visibleLimit);
  const groups = new Map();
  page.forEach(t => {
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
  `).join('') + (tasks.length > page.length ? loadMoreRow(tasks.length - page.length) : '');
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
export function initListView(onSectionFilter = requestRender) {
  const list = document.getElementById('task-list');
  if (list && !list._inlineAddBound) {
    list._inlineAddBound = true;
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-inline-add-task]');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      let defaults = {};
      try { defaults = JSON.parse(decodeURIComponent(btn.dataset.inlineAddTask || '%7B%7D')); } catch {}
      services.openQuickAdd(defaults);
    });
  }

  // Grouped views (Upcoming, Today) let a task be dragged onto another day
  // header to reschedule it.
  list.addEventListener('dragstart', (e) => {
    const row = e.target.closest('li[data-task-id][draggable="true"]');
    if (!row || !e.dataTransfer) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', row.dataset.taskId);
  });
  list.addEventListener('dragover', (e) => {
    const header = e.target.closest('.day-group-header[data-day-group]');
    if (!header || !/^\d{4}-\d{2}-\d{2}$/.test(header.dataset.dayGroup)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    header.classList.add('cal-drop-target');
  });
  list.addEventListener('dragleave', (e) => {
    const header = e.target.closest('.day-group-header[data-day-group]');
    if (header) header.classList.remove('cal-drop-target');
  });
  list.addEventListener('drop', (e) => {
    const header = e.target.closest('.day-group-header[data-day-group]');
    if (!header) return;
    header.classList.remove('cal-drop-target');
    const day = header.dataset.dayGroup;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !e.dataTransfer) return;
    e.preventDefault();
    const task = state.tasks.find(t => t.id === e.dataTransfer.getData('text/plain'));
    if (!task || task.due === day) return;
    task.due = day;
    saveState();
    requestRender();
  });

  list.addEventListener('click', async (e) => {
    const more = e.target.closest('[data-load-more], #load-more-btn');
    if (more) {
      visibleLimit += PAGE_SIZE;
      onSectionFilter();
      return;
    }

    const sectionMenuBtn = e.target.closest('[data-section-menu]');
    if (sectionMenuBtn) {
      e.preventDefault();
      e.stopPropagation();
      const id = sectionMenuBtn.dataset.sectionMenu;
      const panel = list.querySelector(`[data-section-menu-panel="${CSS.escape(id)}"]`);
      list.querySelectorAll('[data-section-menu-panel]').forEach(p => { if (p !== panel) p.classList.add('hidden'); });
      panel?.classList.toggle('hidden');
      return;
    }

    const sectionAction = e.target.closest('[data-section-action]');
    if (sectionAction) {
      e.preventDefault();
      e.stopPropagation();
      const action = sectionAction.dataset.sectionAction;
      const sectionId = sectionAction.dataset.sectionId;
      const projId = String(state.ui.view || '').startsWith('project:') ? state.ui.view.slice(8) : null;
      list.querySelectorAll('[data-section-menu-panel]').forEach(p => p.classList.add('hidden'));
      if (!projId || !sectionId) return;
      if (action === 'archive') {
        setSectionArchived(projId, sectionId, true);
        showToast('Section archived', 'success');
        return;
      }
      if (action === 'unarchive') {
        setSectionArchived(projId, sectionId, false);
        showToast('Section unarchived', 'success');
        return;
      }
      if (action === 'delete') {
        await deleteSection(projId, sectionId);
        return;
      }
      if (action === 'duplicate') {
        await duplicateSection(projId, sectionId);
        return;
      }
      if (action === 'move') {
        const targets = state.projects.filter(p => p.id !== projId && !p.archived);
        if (!targets.length) { showToast('No other project to move to', 'error'); return; }
        // simple prompt for now; pick by name/index fallback not needed if prompt supports names poorly, but acceptable
        const names = targets.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
        const answer = window.prompt(`Move section to which project?\n${names}\n\nEnter project number:`, '1');
        if (!answer) return;
        const idx = Number(answer) - 1;
        const target = targets[idx];
        if (!target) { showToast('Invalid project selection', 'error'); return; }
        await moveSection(projId, sectionId, target.id);
        return;
      }
    }

    const toggle = e.target.closest('[data-section-toggle]');
    if (toggle) {
      const id = toggle.dataset.sectionToggle;
      if (!id) return;
      e.preventDefault();
      if (!state.ui.collapsedProjectSections || typeof state.ui.collapsedProjectSections !== 'object') state.ui.collapsedProjectSections = {};
      state.ui.collapsedProjectSections[id] = !state.ui.collapsedProjectSections[id];
      saveState();
      onSectionFilter();
      return;
    }

    const chip = e.target.closest('[data-section-filter]');
    if (!chip) return;
    e.preventDefault();
    e.stopPropagation();
    projectSectionFilter = chip.dataset.sectionFilter || null;
    onSectionFilter();
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-section-menu]') && !e.target.closest('[data-section-menu-panel]')) {
      document.querySelectorAll('[data-section-menu-panel]').forEach(p => p.classList.add('hidden'));
    }
  });
}
