/**
 * The sidebar: navigation, projects, saved filters and labels.
 */
import { state, saveState } from '../core/state.js';
import { todayISO, isTaskOverdue } from '../core/dates.js';
import { escapeHtml } from '../core/text.js';
import { projectName, labelName } from '../core/tasks.js';
import { snapshotData, offerUndo } from '../core/undo.js';
import { requestRender } from '../core/render.js';
import { services } from '../core/services.js';
import { savedFilters, filterTaskCount } from '../features/filters.js';

export function renderSidebar() {
  // counts
  const inboxCount = state.tasks.filter(t => !t.parentId && !t.projectId && !t.completed).length;
  const todayCount = state.tasks.filter(t => !t.parentId && !t.completed && (t.due === todayISO() || isTaskOverdue(t))).length;
  const completedCount = state.tasks.filter(t => t.completed).length;
  const noDateCount = state.tasks.filter(t => !t.parentId && !t.completed && !t.due).length;
  const noPriorityCount = state.tasks.filter(t => !t.parentId && !t.completed && t.priority === 4).length;
  document.querySelector('[data-view="inbox"] .nav-count').textContent = inboxCount || '';
  document.querySelector('[data-view="today"] .nav-count').textContent = todayCount || '';
  document.querySelector('[data-view="completed"] .nav-count').textContent = completedCount || '';
  document.querySelector('[data-view="no-date"] .nav-count').textContent = noDateCount || '';
  document.querySelector('[data-view="no-priority"] .nav-count').textContent = noPriorityCount || '';

  // active nav
  document.querySelectorAll('.nav-item').forEach(el => {
    const isActive = el.dataset.view && el.dataset.view === state.ui.view;
    el.classList.toggle('bg-red-50', isActive);
    el.classList.toggle('text-td-red', isActive);
    el.classList.toggle('font-medium', isActive);
  });

  // projects (pinned first, stable among the rest)
  const pl = document.getElementById('projects-list');
  pl.innerHTML = [...state.projects]
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
    .map(p => {
      const count = state.tasks.filter(t => !t.parentId && !t.completed && t.projectId === p.id).length;
      const active = state.ui.view === `project:${p.id}`;
      return `
      <div class="group relative" data-entry-id="${escapeHtml(p.id)}">
        <a href="#" data-view="project:${p.id}" title="${escapeHtml(p.name)}" class="nav-item flex items-center gap-2 px-2 py-1.5 pr-12 rounded hover:bg-gray-200/60 text-sm ${active ? 'bg-red-50 text-td-red font-medium' : ''}">
          <i data-lucide="hash" class="w-4 h-4 flex-shrink-0" style="color:${p.color}"></i>
          <span class="sidebar-hide truncate flex-1">${escapeHtml(p.name)}</span>
          ${p.pinned ? '<i data-lucide="star" class="sidebar-hide w-3 h-3 flex-shrink-0 text-amber-500" fill="currentColor" title="Pinned"></i>' : ''}
          <span class="sidebar-hide text-xs text-td-muted">${count || ''}</span>
        </a>
        <button type="button" class="project-quick-add sidebar-hide absolute right-7 top-1/2 -translate-y-1/2 p-0.5 rounded text-td-muted opacity-100 md:opacity-0 md:group-hover:opacity-100 focus:opacity-100 pointer-events-auto md:pointer-events-none md:group-hover:pointer-events-auto hover:text-td-text"
          data-project-id="${p.id}" title="Add task to ${escapeHtml(p.name)}" aria-label="Add task to ${escapeHtml(p.name)}">
          <i data-lucide="plus" class="w-3.5 h-3.5"></i>
        </button>
        <button type="button" class="sidebar-hide row-menu-btn absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded text-td-muted opacity-100 md:opacity-0 md:group-hover:opacity-100 focus:opacity-100 pointer-events-auto md:pointer-events-none md:group-hover:pointer-events-auto hover:text-td-text"
          data-menu-type="project" data-menu-id="${p.id}" title="Project actions" aria-label="Project actions">
          <i data-lucide="more-horizontal" class="w-4 h-4"></i>
        </button>
      </div>`;
    }).join('');

  // saved filters
  const fl = document.getElementById('filters-list');
  fl.innerHTML = savedFilters.map(f => {
    const count = filterTaskCount(f.query);
    const active = state.ui.view === `filter:${f.id}`;
    return `
    <div class="group relative">
      <a href="#" data-view="filter:${escapeHtml(f.id)}" title="${escapeHtml(f.query)}" class="nav-item flex items-center gap-2 px-2 py-1.5 pr-6 rounded hover:bg-gray-200/60 text-sm ${active ? 'bg-red-50 text-td-red font-medium' : ''}">
        <i data-lucide="filter" class="w-4 h-4 flex-shrink-0 text-td-muted"></i>
        <span class="sidebar-hide truncate flex-1">${escapeHtml(f.name)}</span>
        <span class="sidebar-hide text-xs text-td-muted">${count || ''}</span>
      </a>
      <button type="button" class="sidebar-hide row-menu-btn absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded text-td-muted opacity-100 md:opacity-0 md:group-hover:opacity-100 focus:opacity-100 pointer-events-auto md:pointer-events-none md:group-hover:pointer-events-auto hover:text-td-text"
        data-menu-type="filter" data-menu-id="${escapeHtml(f.id)}" title="Filter actions" aria-label="Filter actions">
        <i data-lucide="more-horizontal" class="w-4 h-4"></i>
      </button>
    </div>`;
  }).join('');

  // labels (pinned first)
  const ll = document.getElementById('labels-list');
  ll.innerHTML = [...state.labels]
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
    .map(l => {
      const active = state.ui.view === `label:${l.id}`;
      return `
      <div class="group relative" data-entry-id="${escapeHtml(l.id)}">
        <a href="#" data-view="label:${l.id}" title="@${escapeHtml(l.name)}" class="nav-item flex items-center gap-2 px-2 py-1.5 pr-6 rounded hover:bg-gray-200/60 text-sm ${active ? 'bg-red-50 text-td-red font-medium' : ''}">
          <i data-lucide="tag" class="w-4 h-4 flex-shrink-0" style="color:${l.color}"></i>
          <span class="sidebar-hide truncate flex-1">@${escapeHtml(l.name)}</span>
          ${l.pinned ? '<i data-lucide="star" class="sidebar-hide w-3 h-3 flex-shrink-0 text-amber-500" fill="currentColor" title="Pinned"></i>' : ''}
        </a>
        <button type="button" class="sidebar-hide row-menu-btn absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded text-td-muted opacity-100 md:opacity-0 md:group-hover:opacity-100 focus:opacity-100 pointer-events-auto md:pointer-events-none md:group-hover:pointer-events-auto hover:text-td-text"
          data-menu-type="label" data-menu-id="${l.id}" title="Label actions" aria-label="Label actions">
          <i data-lucide="more-horizontal" class="w-4 h-4"></i>
        </button>
      </div>`;
    }).join('');

  document.querySelectorAll('.row-menu-btn').forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      services.openRowMenu(btn, btn.dataset.menuType, btn.dataset.menuId);
    };
  });

  document.querySelectorAll('.project-quick-add').forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      services.navigateTo(`project:${btn.dataset.projectId}`);
      services.closeMobileSidebar();
      services.openQuickAdd();
    };
  });

  bindSidebarSortables();
  bindSidebarDropTargets();
}

/** Lets a task be dragged onto a project or label in the sidebar. */
function bindSidebarDropTargets() {
  document.querySelectorAll('#projects-list > div, #labels-list > div').forEach(row => {
    if (row._dropTarget) { row._dropTarget.destroy(); row._dropTarget = null; }
    const isProject = !!row.closest('#projects-list');
    row._dropTarget = new Sortable(row, {
      group: { name: 'td-tasks', pull: false, put: true },
      sort: false,
      animation: 150,
      onAdd: (evt) => {
        const id = evt.item && evt.item.dataset ? evt.item.dataset.taskId : null;
        const task = state.tasks.find(t => t.id === id);
        if (!task) return;
        const targetId = row.dataset.entryId;
        const snapshot = snapshotData();
        if (isProject) {
          if (task.projectId === targetId) return;
          task.projectId = targetId;
          task.sectionId = null; // sections belong to the previous project
          saveState();
          requestRender();
          offerUndo(`Moved to ${projectName(targetId)}`, snapshot);
        } else {
          if ((task.labels || []).includes(targetId)) return;
          task.labels = [...(task.labels || []), targetId];
          saveState();
          requestRender();
          offerUndo(`Label @${labelName(targetId)} added`, snapshot);
        }
      },
    });
  });
}

/** Lets projects and labels be dragged into a new order. */
function bindSidebarSortables() {
  [['#projects-list', 'projects'], ['#labels-list', 'labels']].forEach(([sel, kind]) => {
    const el = document.querySelector(sel);
    if (!el) return;
    if (el._sortable) { el._sortable.destroy(); el._sortable = null; }
    el._sortable = new Sortable(el, {
      animation: 150,
      handle: '.nav-item',
      filter: 'button',
      onEnd: () => {
        const ids = [...el.querySelectorAll(':scope > div')].map(d => d.dataset.entryId).filter(Boolean);
        const list = kind === 'projects' ? state.projects : state.labels;
        const byId = new Map(list.map(x => [x.id, x]));
        const next = ids.map(i => byId.get(i)).filter(Boolean);
        list.forEach(x => { if (!ids.includes(x.id)) next.push(x); });
        if (kind === 'projects') state.projects = next;
        else state.labels = next;
        saveState();
        requestRender();
      },
    });
  });
}
