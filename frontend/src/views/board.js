/**
 * The board view: one column per project section (Todoist behaviour) or,
 * outside a project, one column per priority.
 */
import { state, saveState } from '../core/state.js';
import { activeTasks, priorityColor, projectName, taskReminders } from '../core/tasks.js';
import { formatDue, isTaskOverdue, todayISO } from '../core/dates.js';
import { escapeHtml, highlightHtml } from '../core/text.js';
import { bindTaskEvents, taskPriorityMarker, durationBadge, searchTerm } from '../features/task-row.js';

const BOARD_PRIORITIES = [1, 2, 3, 4];

/** A project board groups by section; other views keep the priority columns. */
export function boardGrouping() {
  const view = state.ui.view || '';
  const project = view.startsWith('project:')
    ? state.projects.find(p => p.id === view.slice(8))
    : null;
  const sections = project && Array.isArray(project.sections) ? project.sections.filter(s => !s.archived) : [];
  return { project, sections, bySection: !!project && sections.length > 0 };
}

export function renderBoard(info) {
  const list = document.getElementById('task-list');
  const board = document.getElementById('board-view');
  list.classList.add('hidden');
  list.innerHTML = '';
  board.classList.remove('hidden');
  document.getElementById('content-container').classList.add('board-mode');

  const base = activeTasks().filter(info.filter).filter(t => !t.completed);
  const grouping = boardGrouping();
  const archivedSectionIds = new Set((grouping.project?.sections || []).filter(s => s.archived).map(s => s.id));
  const baseVisible = grouping.bySection ? base.filter(t => !archivedSectionIds.has(t.sectionId)) : base;

  const columns = grouping.bySection
    ? [
        ...grouping.sections.map(s => ({
          key: s.id,
          label: s.name,
          sectionId: s.id,
          tasks: baseVisible.filter(t => t.sectionId === s.id),
        })),
        (() => {
          const ungrouped = baseVisible.filter(t => !t.sectionId || !grouping.sections.some(s => s.id === t.sectionId));
          return ungrouped.length
            ? { key: 'none', label: 'No section', sectionId: '', tasks: ungrouped }
            : null;
        })(),
      ].filter(Boolean)
    : BOARD_PRIORITIES.map(priority => ({
        key: String(priority),
        label: `P${priority}`,
        priority,
        tasks: baseVisible.filter(t => t.priority === priority),
      }));

  board.innerHTML = `<div class="board-scroll"><div class="board-grid">` + columns.map(column => {
    const tasks = [...column.tasks].sort((a, b) => a.order - b.order);
    const isSection = grouping.bySection;
    const icon = isSection ? 'columns-3' : 'flag';
    const color = isSection
      ? (column.sectionId ? '#246fe0' : '#808080')
      : priorityColor(column.priority);
    const attrs = isSection
      ? `data-group="section" data-section-id="${escapeHtml(column.sectionId)}"`
      : `data-group="priority" data-priority="${column.priority}"`;
    return `
      <section class="board-column" ${attrs}>
        <header class="board-column-header">
          <span class="flex items-center gap-1.5 text-sm font-semibold min-w-0">
            <i data-lucide="${escapeHtml(icon)}" class="w-3.5 h-3.5 flex-shrink-0" style="color:${escapeHtml(color)}"></i>
            <span class="truncate">${escapeHtml(column.label)}</span>
          </span>
          <span class="board-count text-xs text-td-muted" title="${tasks.length} tasks">${tasks.length}</span>
        </header>
        <ul class="board-cards" ${attrs} aria-label="${escapeHtml(column.label)}">
          ${tasks.map(t => renderBoardCard(t)).join('')}
        </ul>
      </section>`;
  }).join('') + `</div></div>` + `<div class="board-scroll-hint" aria-hidden="true"><i data-lucide="move-right" class="w-3.5 h-3.5"></i>Scroll for more</div>`;
  document.getElementById('empty-state').classList.add('hidden');

  bindTaskEvents(false);
  bindBoardSortables();
  updateBoardOverflowHint();
}

export function renderBoardCard(t) {
  const dueBadge = t.due ? `
    <span class="flex items-center gap-1 ${isTaskOverdue(t) ? 'text-red-600' : t.due === todayISO() ? 'text-green-700' : 'text-td-muted'}">
      <i data-lucide="calendar" class="w-3 h-3"></i>${escapeHtml(formatDue(t.due, t.dueTime))}
      ${t.recurrence ? '<i data-lucide="repeat" class="w-3 h-3 ml-0.5"></i>' : ''}
    </span>` : '';
  const reminderBadge = taskReminders(t).length ? `
    <span class="flex items-center gap-1 text-td-muted" title="Reminders">
      <i data-lucide="bell" class="w-3 h-3"></i>
    </span>` : '';
  const projBadge = t.projectId ? `
    <span class="flex items-center gap-1 text-td-muted">
      <i data-lucide="hash" class="w-3 h-3" style="color:${escapeHtml(state.projects.find(p => p.id === t.projectId)?.color || '#999')}"></i>${escapeHtml(projectName(t.projectId))}
    </span>` : '';
  const labelBadges = (t.labels || []).map(lid => {
    const l = state.labels.find(x => x.id === lid);
    if (!l) return '';
    return `<span class="flex items-center gap-0.5 text-td-muted"><i data-lucide="tag" class="w-3 h-3" style="color:${escapeHtml(l.color)}"></i>@${escapeHtml(l.name)}</span>`;
  }).join('');

  return `
    <li class="board-card group" data-task-id="${t.id}">
      <div class="flex items-start gap-2 p-2.5">
        <button class="task-check mt-0.5 flex-shrink-0 w-[18px] h-[18px] rounded-full border-2 flex items-center justify-center"
          style="border-color:${priorityColor(t.priority)}" title="Complete task">
        </button>
        <div class="flex-1 min-w-0">
          <div class="task-title cursor-pointer text-sm font-medium" tabindex="0">${taskPriorityMarker(t)}${highlightHtml(t.title, searchTerm())}</div>
          ${t.description ? `<div class="text-xs text-td-muted mt-0.5 truncate-2">${highlightHtml(t.description, searchTerm())}</div>` : ''}
          <div class="flex flex-wrap items-center gap-2 text-xs mt-1">
            ${dueBadge}${reminderBadge}${durationBadge(t)}${projBadge}${labelBadges}
          </div>
        </div>
        <div class="task-actions flex items-center gap-0.5">
          <button class="task-edit text-td-muted hover:text-td-text p-1" title="Edit">
            <i data-lucide="pencil" class="w-3.5 h-3.5"></i>
          </button>
          <button class="task-delete text-td-muted hover:text-red-600 p-1" title="Delete">
            <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
          </button>
        </div>
      </div>
    </li>`;
}

/** One Sortable group; dropping into a column rewrites the task's priority. */
export function destroyBoardSortables() {
  document.querySelectorAll('.board-cards').forEach(el => {
    if (el._sortable) { el._sortable.destroy(); el._sortable = null; }
  });
}

export function bindBoardSortables() {
  const board = document.getElementById('board-view');
  if (!board) return;
  destroyBoardSortables();
  board.querySelectorAll('.board-cards').forEach(el => {
    el._sortable = new Sortable(el, {
      group: 'board-tasks',
      animation: 150,
      handle: '.board-card',
      filter: 'button',
      ghostClass: 'board-card-ghost',
      onEnd: (evt) => {
        const taskId = evt.item && evt.item.dataset ? evt.item.dataset.taskId : null;
        const task = state.tasks.find(x => x.id === taskId);
        const to = evt.to;
        if (!task || !to) return;
        const column = to.closest ? to.closest('.board-column') : null;
        if (column && column.dataset.group === 'section') {
          // Dragging between section columns rewrites the section (and the
          // project, in case the card came from elsewhere).
          const project = boardGrouping().project;
          if (project) task.projectId = project.id;
          task.sectionId = column.dataset.sectionId || null;
        } else {
          const priority = Number((column && column.dataset.priority) || to.dataset.priority);
          if (priority >= 1 && priority <= 4) task.priority = priority;
        }

        let order = 0;
        board.querySelectorAll('.board-cards .board-card').forEach(card => {
          const t = state.tasks.find(x => x.id === card.dataset.taskId);
          if (t) t.order = order++;
        });
        saveState();
        updateBoardCounts();
      },
    });
  });
}

/** Shows a "scroll for more" hint while board columns are off-screen. */
export function updateBoardOverflowHint() {
  const view = document.getElementById('board-view');
  if (!view) return;
  const scroller = view.querySelector('.board-scroll');
  if (!scroller) {
    view.classList.remove('board-overflow');
    return;
  }
  const overflowing = scroller.scrollWidth > scroller.clientWidth + 1;
  const atEnd = scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 2;
  view.classList.toggle('board-overflow', overflowing && !atEnd);
}

export function updateBoardCounts() {
  document.querySelectorAll('.board-column').forEach(col => {
    const count = col.querySelectorAll('.board-card').length;
    const badge = col.querySelector('.board-count');
    if (badge) {
      badge.textContent = String(count);
      badge.title = `${count} tasks`;
    }
  });
}

/** Watches the board for horizontal overflow. */
export function initBoard() {
  document.getElementById('board-view').addEventListener('scroll', updateBoardOverflowHint, true);
  window.addEventListener('resize', updateBoardOverflowHint);
}
