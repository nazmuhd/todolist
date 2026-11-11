/**
 * The task context menu (right click), with complete, reschedule, priority,
 * project and label actions.
 */
import { $ } from '../core/app.js';
import { state, saveState } from '../core/state.js';
import { toggleComplete, skipOccurrence, snoozeTask, deleteTask, priorityColor, projectName, labelName } from '../core/tasks.js';
import { toISODate, todayISO, formatDue } from '../core/dates.js';
import { snapshotData, offerUndo } from '../core/undo.js';
import { showToast } from '../core/toasts.js';
import { escapeHtml } from '../core/text.js';
import { requestRender } from '../core/render.js';
import { services } from '../core/services.js';
import { positionContextMenu } from '../ui/menus.js';

const contextMenu = $('#context-menu');
let contextTaskId = null;

export function isContextMenuOpen() {
  return !contextMenu.classList.contains('hidden');
}

export function closeContextMenu() {
  contextTaskId = null;
  contextMenu.classList.add('hidden');
  contextMenu.innerHTML = '';
}

export function openContextMenu(taskId, x, y) {
  const t = state.tasks.find(task => task.id === taskId);
  if (!t) return;
  contextTaskId = taskId;

  const items = [];
  const sep = () => items.push({ sep: true });
  const header = (label) => items.push({ header: label });
  const item = (action, label, icon, extra = {}) => items.push({ action, label, icon, ...extra });

  item('complete', t.completed ? 'Reopen task' : 'Complete task', t.completed ? 'rotate-ccw' : 'circle-check');
  sep();

  if (t.recurrence) {
    item('skip-occurrence', 'Skip this occurrence', 'calendar-off');
  }
  if (t.due) {
    item('snooze', 'Snooze until tomorrow', 'moon');
  }
  if (t.recurrence || t.due) sep();

  header('Reschedule');
  item('due-today', 'Today', 'calendar');
  item('due-tomorrow', 'Tomorrow', 'calendar');
  item('due-next-week', 'Next week', 'calendar');
  item('due-none', 'No date', 'calendar-x');
  sep();

  header('Priority');
  [1, 2, 3, 4].forEach(p => {
    item(`priority-${p}`, `Priority ${p}`, 'flag', { checked: t.priority === p, color: priorityColor(p) });
  });
  sep();

  const projects = state.projects.slice(0, 8);
  if (projects.length) {
    header('Move to project');
    item('project-none', 'No project', 'hash', { checked: !t.projectId });
    projects.forEach(p => {
      item(`project-${p.id}`, p.name, 'hash', { checked: t.projectId === p.id, color: p.color });
    });
    sep();
  }

  const labels = state.labels.slice(0, 8);
  if (labels.length) {
    header('Labels');
    item('label-none', 'Clear labels', 'tag', { checked: !(t.labels || []).length });
    labels.forEach(l => {
      item(`label-${l.id}`, `@${l.name}`, 'tag', { checked: (t.labels || []).includes(l.id), color: l.color });
    });
    sep();
  }

  item('edit', 'Edit task', 'pencil');
  item('delete', 'Delete task', 'trash-2', { danger: true });

  contextMenu.innerHTML = items.map(it => {
    if (it.sep) return '<div class="context-sep"></div>';
    if (it.header) return `<div class="context-label">${escapeHtml(it.label)}</div>`;
    const iconStyle = it.color ? ` style="color:${escapeHtml(it.color)}"` : '';
    return `<button type="button" class="context-item${it.danger ? ' danger' : ''}" data-context-action="${escapeHtml(it.action)}">
      <i data-lucide="${it.icon}" class="w-3.5 h-3.5 flex-shrink-0"${it.color ? iconStyle : ' style="color:#808080"'}></i>
      <span class="flex-1 truncate text-left">${escapeHtml(it.label)}</span>
      ${it.checked ? '<i data-lucide="check" class="w-3.5 h-3.5 flex-shrink-0"></i>' : ''}
    </button>`;
  }).join('');

  contextMenu.classList.remove('hidden');
  lucide.createIcons();
  positionContextMenu(contextMenu, x, y);
}

/** Applies a context-menu action to a task. */
export function runContextAction(action, id) {
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;

  if (action === 'complete') { toggleComplete(id); return; }
  if (action === 'skip-occurrence') { const task = state.tasks.find(x => x.id === id); if (task) skipOccurrence(task); return; }
  if (action === 'snooze') { const task = state.tasks.find(x => x.id === id); if (task) snoozeTask(task); return; }
  if (action === 'edit') { services.openTaskModal(id); return; }
  if (action === 'delete') { deleteTask(id); return; }

  if (action.startsWith('priority-')) {
    const p = Number(action.slice('priority-'.length));
    if (!Number.isInteger(p) || p < 1 || p > 4) return;
    t.priority = p;
    saveState();
    requestRender();
    showToast(`Priority ${p}`, 'info');
    return;
  }

  if (action.startsWith('label-')) {
    const labelId = action.slice('label-'.length);
    const current = t.labels || [];
    const next = labelId === 'none'
      ? []
      : (current.includes(labelId) ? current.filter(x => x !== labelId) : [...current, labelId]);
    if (next.length === current.length) return;
    const snapshot = snapshotData();
    t.labels = next;
    saveState();
    requestRender();
    offerUndo(next.length ? `Label @${labelName(labelId)} added` : 'Label removed', snapshot);
    return;
  }

  if (action.startsWith('project-')) {
    const projectId = action.slice('project-'.length);
    const next = projectId === 'none' ? null : projectId;
    if (next && !state.projects.some(p => p.id === next)) return;
    if (t.projectId === next) return;
    const snapshot = snapshotData();
    t.projectId = next;
    saveState();
    requestRender();
    offerUndo(next ? `Moved to ${projectName(next)}` : 'Removed from project', snapshot);
    return;
  }

  if (action.startsWith('due-')) {
    const snapshot = snapshotData();
    const d = new Date();
    if (action === 'due-today') t.due = todayISO();
    else if (action === 'due-tomorrow') { d.setDate(d.getDate() + 1); t.due = toISODate(d); }
    else if (action === 'due-next-week') { d.setDate(d.getDate() + 7); t.due = toISODate(d); }
    else if (action === 'due-none') {
      t.due = null;
      t.dueTime = null;
      t.recurrence = null;
      t.reminderFiredKey = null;
    } else {
      return;
    }
    t.reminderFiredKey = null;
    saveState();
    requestRender();
    offerUndo(t.due ? `Moved to ${formatDue(t.due, t.dueTime)}` : 'Date removed', snapshot);
  }
}

contextMenu.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-context-action]');
  if (!btn) return;
  e.stopPropagation();
  const id = contextTaskId;
  const action = btn.dataset.contextAction;
  closeContextMenu();
  if (id) runContextAction(action, id);
});

document.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('[data-task-id]');
  if (!row) return;
  e.preventDefault();
  services.closeRowMenu();
  const x = e.clientX;
  const y = e.clientY;
  // Deferred so the click that may follow a right-click cannot close it.
  setTimeout(() => openContextMenu(row.dataset.taskId, x, y), 0);
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('#context-menu')) closeContextMenu();
});

window.addEventListener('scroll', closeContextMenu, true);
window.addEventListener('resize', closeContextMenu);
