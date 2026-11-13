/**
 * The task row: one line of the list.
 *
 * The row is rendered as HTML and then wired to the events the user
 * expects (complete, edit in place, add a subtask, delete). The dialogs
 * it opens are app-level features, so they are reached through the
 * service registry rather than an import (which would be a cycle).
 */
import { state, saveState } from '../core/state.js';
import { addTask, toggleComplete, deleteTask, subtasksOf, priorityColor, priorityLabel, projectName, labelName, taskReminders } from '../core/tasks.js';
import { taskLevel } from '../core/priorities.js';
import { formatDue, isTaskOverdue, isDeadlineOverdue, todayISO, formatDuration } from '../core/dates.js';
import { escapeHtml, highlightHtml } from '../core/text.js';
import { renderMarkdownInline } from '../core/markdown.js';
import { requestRender } from '../core/render.js';
import { services } from '../core/services.js';
import { recordActivity } from '../core/activity.js';
import { selectTask, renderSelection } from './selection.js';

/**
 * Priorities are also marked with a shape, so the level is readable
 * without relying on colour (red and orange are hard to tell apart for
 * some colour-blind users).
 */
export function priorityMarker(p) {
  if (p === 1) return '<span class="prio-marker prio-1" aria-hidden="true"></span>';
  if (p === 2) return '<span class="prio-marker prio-2" aria-hidden="true"></span>';
  if (p === 3) return '<span class="prio-marker prio-3" aria-hidden="true"></span>';
  return '';
}

/** The marker for a task, taking a custom level into account. */
export function taskPriorityMarker(t) {
  const level = taskLevel(t);
  if (level && level.custom) {
    return `<span class="prio-marker prio-custom" aria-hidden="true" style="background:${escapeHtml(level.color)};border-color:${escapeHtml(level.color)}"></span>`;
  }
  return priorityMarker(t && t.priority);
}

/** The "30m" chip next to a task that has a duration. */
export function durationBadge(t) {
  const text = formatDuration(t && t.durationMinutes);
  if (!text) return '';
  return `<span class="flex items-center gap-1 text-td-muted"><i data-lucide="clock" class="w-3 h-3"></i>${text}</span>`;
}

/** The term the user is currently searching for (empty when not searching). */
export function searchTerm() {
  return (state.ui.search || '').trim();
}

export function renderTaskRow(t, isSub, opts = {}) {
  // Sub-tasks can nest, so children are rendered at every level.
  const subs = opts.noSubtasks ? [] : subtasksOf(t.id);
  const parentBadge = opts.parentTitle ? `
    <span class="flex items-center gap-1 text-td-muted">
      <i data-lucide="corner-down-right" class="w-3 h-3"></i>${escapeHtml(opts.parentTitle)}
    </span>` : '';
  const dueBadge = t.due ? `
    <span class="flex items-center gap-1 ${isTaskOverdue(t) ? 'text-red-600' : t.due === todayISO() ? 'text-green-700' : 'text-td-muted'}">
      <i data-lucide="calendar" class="w-3 h-3"></i>${escapeHtml(formatDue(t.due, t.dueTime))}
      ${t.recurrence ? `<i data-lucide="${t.recurrenceMode === 'completion' ? 'refresh-cw' : 'repeat'}" class="w-3 h-3 ml-0.5" title="${t.recurrenceMode === 'completion' ? 'Repeats from completion' : 'Repeats from due date'}"></i>` : ''}
    </span>` : '';
  // Reminders are independent of the due date (absolute reminders can exist
  // on their own), so the bell is its own badge.
  const reminderBadge = taskReminders(t).length ? `
    <span class="flex items-center gap-1 text-td-muted" title="Reminders">
      <i data-lucide="bell" class="w-3 h-3"></i>
    </span>` : '';
  const deadlineBadge = t.deadline ? `
    <span class="flex items-center gap-1 ${isDeadlineOverdue(t) ? 'text-red-600' : 'text-td-muted'}" title="Deadline">
      <i data-lucide="octagon-alert" class="w-3 h-3"></i>${escapeHtml(formatDue(t.deadline, t.deadlineTime))}
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

  const level = taskLevel(t);
  const checkColor = level ? level.color : '#999';
  const completedClass = t.completed ? 'line-through text-td-muted' : '';

  return `
    <li class="task-row group" data-task-id="${t.id}"${opts.draggable && !isSub ? ' draggable="true"' : ''}>
      <div class="flex items-start gap-2 py-2 px-1 border-b border-gray-100 hover:bg-gray-50 rounded">
        <button class="task-check mt-0.5 flex-shrink-0 w-[18px] h-[18px] rounded-full border-2 flex items-center justify-center"
          style="border-color:${t.completed ? '#808080' : checkColor}; ${t.completed ? 'background:#808080;' : ''}"
          title="${t.completed ? 'Reopen task' : 'Complete task'} · ${escapeHtml(level ? level.name : 'No priority')}"
          aria-label="${t.completed ? 'Reopen task' : 'Complete task'} · ${escapeHtml(level ? level.name : 'No priority')}">
          ${t.completed ? '<i data-lucide="check" class="w-3 h-3 text-white"></i>' : ''}
        </button>
        <div class="task-content flex-1 min-w-0">
          <div class="task-title cursor-pointer text-sm ${completedClass}" tabindex="0">${taskPriorityMarker(t)}${highlightHtml(t.title, searchTerm())}</div>
          ${t.description ? `<div class="text-xs text-td-muted mt-0.5 truncate-2 md-inline">${renderMarkdownInline(t.description)}</div>` : ''}
          <div class="flex flex-wrap items-center gap-2 text-xs mt-1">
            ${parentBadge}${dueBadge}${reminderBadge}${deadlineBadge}${durationBadge(t)}${projBadge}${labelBadges}
            ${t.startDate && t.startDate !== t.due ? `<span class="flex items-center gap-1 text-td-muted"><i data-lucide="flag" class="w-3 h-3"></i>starts ${escapeHtml(formatDue(t.startDate))}</span>` : ''}
            ${(t.attachments || []).length ? `<span class="flex items-center gap-1 text-td-muted"><i data-lucide="paperclip" class="w-3 h-3"></i>${t.attachments.length}</span>` : ''}
          </div>
          ${subs.length ? `<ul class="mt-1.5 space-y-0.5 pl-3 border-l-2 border-gray-100">
            ${subs.map(s => renderTaskRow(s, true)).join('')}
          </ul>` : ''}
        </div>
        <div class="task-actions flex items-center gap-0.5">
          <button class="task-edit text-td-muted hover:text-td-text p-1" title="Edit">
            <i data-lucide="pencil" class="w-3.5 h-3.5"></i>
          </button>
          ${!isSub ? `<button class="task-addsub text-td-muted hover:text-td-text p-1" title="Add subtask">
            <i data-lucide="git-branch-plus" class="w-3.5 h-3.5"></i>
          </button>` : ''}
          <button class="task-delete text-td-muted hover:text-red-600 p-1" title="Delete">
            <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
          </button>
        </div>
      </div>
    </li>`;
}

/** Adds a subtask with an inline input (no browser prompt). */
export function openInlineSubtask(parentId) {
  const row = document.querySelector(`[data-task-id="${parentId}"]`);
  if (!row) return;
  const content = row.querySelector('.task-content');
  if (!content) return;

  const existing = content.querySelector('.subtask-inline-editor');
  if (existing) { existing.querySelector('input').focus(); return; }
  document.querySelectorAll('.subtask-inline-editor').forEach(el => el.remove());

  const editor = document.createElement('div');
  editor.className = 'subtask-inline-editor flex items-center gap-2 mt-2 pl-1';

  const icon = document.createElement('i');
  icon.setAttribute('data-lucide', 'git-branch-plus');
  icon.className = 'w-3.5 h-3.5 text-td-muted';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'subtask-inline-input flex-1 text-sm border border-td-border rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-td-red/30';
  input.placeholder = 'Subtask name';

  editor.appendChild(icon);
  editor.appendChild(input);
  content.appendChild(editor);
  lucide.createIcons();

  let settled = false;
  const close = () => { settled = true; editor.remove(); };
  const commit = () => {
    if (settled) return;
    const title = input.value.trim();
    close();
    if (!title) return;
    addTask({ title, parentId });
    // Keep the flow going: show a fresh inline input for the next subtask.
    openInlineSubtask(parentId);
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); commit(); }
    else if (event.key === 'Escape') { event.preventDefault(); close(); }
  });
  input.addEventListener('blur', () => { if (!settled) close(); });

  input.focus();
}

/** Clicking a task title edits it in place; the pencil still opens the modal. */
export function openInlineTitle(taskId) {
  const task = state.tasks.find(t => t.id === taskId);
  const row = document.querySelector(`[data-task-id="${taskId}"]`);
  if (!task || !row) return;
  const titleEl = row.querySelector('.task-title');
  if (!titleEl) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.value = task.title;
  input.className = 'task-title-inline w-full text-sm font-medium border border-td-border rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-td-red/30';
  input.setAttribute('aria-label', 'Task title');
  titleEl.replaceWith(input);

  let settled = false;
  const commit = () => {
    if (settled) return;
    settled = true;
    const title = input.value.trim();
    if (title && title !== task.title) {
      task.title = title;
      saveState();
      recordActivity('edited', task, `renamed to "${title}"`);
    }
    requestRender();
  };
  const cancel = () => {
    if (settled) return;
    settled = true;
    requestRender();
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); commit(); }
    else if (event.key === 'Escape') { event.preventDefault(); cancel(); }
  });
  input.addEventListener('blur', () => { if (!settled) commit(); });

  input.focus();
  input.select();
}

/**
 * Wires the task rows after they are rendered.
 *
 * `sortable` is false for the grouped views (upcoming, today,
 * completed), where the order is the date, not the user's.
 */
/** Touch gestures: swipe right to complete, swipe left to reschedule. */
let taskGesturesBound = false;
function ensureTaskGestures() {
  if (taskGesturesBound) return;
  taskGesturesBound = true;
  let swipe = null;

  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const row = e.target.closest('.task-row');
    if (!row || e.target.closest('button, input, textarea, a')) return;
    const touch = e.touches[0];
    swipe = {
      row,
      id: row.closest('[data-task-id]')?.dataset.taskId || null,
      x: touch.clientX,
      y: touch.clientY,
      dx: 0,
      active: false,
    };
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!swipe || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const dx = touch.clientX - swipe.x;
    const dy = touch.clientY - swipe.y;
    if (!swipe.active) {
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        swipe.active = true;
        swipe.row.classList.add('task-row-swiping');
      } else if (Math.abs(dy) > 16) {
        swipe = null;
        return;
      }
    }
    if (!swipe || !swipe.active) return;
    if (e.cancelable) e.preventDefault();
    swipe.dx = dx;
    const limited = Math.max(-120, Math.min(120, dx));
    swipe.row.style.transform = `translateX(${limited}px)`;
    swipe.row.classList.toggle('swipe-done', limited > 70);
    swipe.row.classList.toggle('swipe-schedule', limited < -70);
  }, { passive: false });

  const endSwipe = (cancelled) => {
    if (!swipe) return;
    const { row, id, active, dx } = swipe;
    swipe = null;
    row.style.transform = '';
    row.classList.remove('task-row-swiping', 'swipe-done', 'swipe-schedule');
    if (cancelled || !active || !id) return;
    if (!state.tasks.some(t => t.id === id)) return;
    if (dx > 70) {
      toggleComplete(id);
    } else if (dx < -70) {
      // Swiping left opens the due-date editor.
      services.openTaskModal(id);
      setTimeout(() => {
        import('./due-editor.js').then(m => m.openDueEditor());
      }, 60);
    }
  };

  document.addEventListener('touchend', () => endSwipe(false));
  document.addEventListener('touchcancel', () => endSwipe(true));
}

export function bindTaskEvents(sortable = true) {
  ensureTaskGestures();
  renderSelection();
  document.querySelectorAll('.task-check').forEach(btn => {
    btn.onclick = (e) => {
      const id = e.currentTarget.closest('[data-task-id]').dataset.taskId;
      const task = state.tasks.find(t => t.id === id);
      if (!task) return;
      if (task.completed) {
        toggleComplete(id);
        return;
      }
      if (btn._busy) return;
      // Give the check a visible pop before a completed task disappears.
      btn._busy = true;
      btn.classList.add('task-check-pop');
      setTimeout(() => toggleComplete(id), 110);
    };
  });
  document.querySelectorAll('.task-title').forEach(el => {
    el.onclick = (e) => {
      const id = el.closest('[data-task-id]').dataset.taskId;
      // Ctrl/Cmd/Shift-click selects instead of editing.
      if (e.ctrlKey || e.metaKey || e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        selectTask(id, e);
        return;
      }
      openInlineTitle(id);
    };
    // Keyboard equivalent: Enter edits, Space completes.
    el.onkeydown = (e) => {
      const id = el.closest('[data-task-id]').dataset.taskId;
      if (e.key === 'Enter') {
        e.preventDefault();
        openInlineTitle(id);
        return;
      }
      if (e.key === ' ') {
        e.preventDefault();
        if (state.tasks.some(t => t.id === id)) toggleComplete(id);
      }
    };
  });
  document.querySelectorAll('.task-row').forEach(row => {
    row.onclick = (e) => {
      if (e.target.closest('button')) return;
      if (!(e.ctrlKey || e.metaKey || e.shiftKey)) return;
      e.preventDefault();
      e.stopPropagation();
      selectTask(row.dataset.taskId, e);
    };
  });
  document.querySelectorAll('.task-edit').forEach(el => {
    el.onclick = (e) => {
      const id = el.closest('[data-task-id]').dataset.taskId;
      services.openTaskModal(id);
    };
  });
  document.querySelectorAll('.task-delete').forEach(el => {
    el.onclick = (e) => {
      const id = el.closest('[data-task-id]').dataset.taskId;
      deleteTask(id);
    };
  });
  document.querySelectorAll('.task-addsub').forEach(el => {
    el.onclick = (e) => {
      const id = el.closest('[data-task-id]').dataset.taskId;
      openInlineSubtask(id);
    };
  });

  // drag reorder (top-level only)
  const list = document.getElementById('task-list');
  if (list._sortable) { list._sortable.destroy(); list._sortable = null; }
  if (!sortable) return;
  list._sortable = new Sortable(list, {
    animation: 150,
    handle: '.task-row',
    filter: 'button',
    // Tasks can also be dropped on a project or label in the sidebar.
    group: { name: 'td-tasks', pull: true, put: true },
    delay: 150,
    delayOnTouchOnly: true,
    onEnd: () => {
      const ids = [...document.querySelectorAll('#task-list > li')].map(li => li.dataset.taskId);
      ids.forEach((id, i) => {
        const t = state.tasks.find(x => x.id === id);
        if (t) t.order = i;
      });
      saveState();
    }
  });
}
