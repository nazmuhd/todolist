/**
 * The table layout: one row per task, with the details in columns.
 *
 * The list layout is one line per task; the table is for scanning a lot of
 * tasks at once, so the columns are the fields you compare: project,
 * labels, priority, due date, deadline and duration.
 */
import { state } from '../core/state.js';
import { activeTasks, priorityColor, priorityLabel, projectName } from '../core/tasks.js';
import { formatDue, isTaskOverdue, isDeadlineOverdue, formatDuration } from '../core/dates.js';
import { escapeHtml, highlightHtml } from '../core/text.js';
import { bindTaskEvents, priorityMarker, searchTerm } from '../features/task-row.js';

const COLUMNS = [
  { id: 'task', label: 'Task', sortable: true },
  { id: 'project', label: 'Project' },
  { id: 'labels', label: 'Labels' },
  { id: 'priority', label: 'Priority' },
  { id: 'due', label: 'Due' },
  { id: 'deadline', label: 'Deadline' },
  { id: 'duration', label: 'Duration' },
];

function cellDue(t) {
  if (!t.due) return '<span class="text-td-muted">—</span>';
  const cls = isTaskOverdue(t) ? 'text-red-600' : 'text-td-text';
  return `<span class="${cls}">${escapeHtml(formatDue(t.due, t.dueTime))}</span>`;
}

function cellDeadline(t) {
  if (!t.deadline) return '<span class="text-td-muted">—</span>';
  const cls = isDeadlineOverdue(t) ? 'text-red-600' : 'text-td-text';
  return `<span class="${cls}">${escapeHtml(formatDue(t.deadline, t.deadlineTime))}</span>`;
}

function cellPriority(t) {
  return `<span class="flex items-center gap-1.5 whitespace-nowrap">
    ${priorityMarker(t.priority)}
    <span class="text-td-muted">${escapeHtml(priorityLabel(t.priority))}</span>
  </span>`;
}

function cellProject(t) {
  if (!t.projectId) return '<span class="text-td-muted">—</span>';
  const color = state.projects.find(p => p.id === t.projectId)?.color || '#999';
  return `<span class="flex items-center gap-1 whitespace-nowrap">
    <i data-lucide="hash" class="w-3.5 h-3.5" style="color:${color}"></i>${escapeHtml(projectName(t.projectId))}
  </span>`;
}

function cellLabels(t) {
  const labels = (t.labels || []).map(lid => {
    const l = state.labels.find(x => x.id === lid);
    if (!l) return '';
    return `<span class="flex items-center gap-0.5 whitespace-nowrap"><i data-lucide="tag" class="w-3 h-3" style="color:${l.color}"></i>@${escapeHtml(l.name)}</span>`;
  }).filter(Boolean).join(' ');
  return labels || '<span class="text-td-muted">—</span>';
}

/** Renders the table for the current view. */
export function renderTable(info) {
  const list = document.getElementById('task-list');
  list.innerHTML = '';

  const tasks = activeTasks()
    .filter(info.filter)
    .filter(t => !t.completed);

  if (!tasks.length) {
    list.innerHTML = '';
    return;
  }

  const head = COLUMNS.map(c => `
    <th scope="col" class="text-left text-xs font-semibold text-td-muted uppercase tracking-wide py-2 px-2 whitespace-nowrap">${escapeHtml(c.label)}</th>
  `).join('');

  const body = tasks.map(t => `
    <tr class="task-row border-b border-gray-100 hover:bg-gray-50" data-task-id="${t.id}">
      <td class="py-1.5 px-2 align-top">
        <div class="flex items-start gap-2">
          <button class="task-check mt-0.5 flex-shrink-0 w-[18px] h-[18px] rounded-full border-2 flex items-center justify-center"
            style="border-color:${priorityColor(t.priority)}" title="Complete task" aria-label="Complete task"></button>
          <div class="task-content min-w-0">
            <div class="task-title cursor-pointer text-sm ${t.completed ? 'line-through text-td-muted' : ''}" tabindex="0">${priorityMarker(t.priority)}${highlightHtml(t.title, searchTerm())}</div>
            ${t.description ? `<div class="text-xs text-td-muted truncate-2 md-inline">${escapeHtml(t.description)}</div>` : ''}
          </div>
        </div>
      </td>
      <td class="py-1.5 px-2 align-top text-xs">${cellProject(t)}</td>
      <td class="py-1.5 px-2 align-top text-xs">${cellLabels(t)}</td>
      <td class="py-1.5 px-2 align-top text-xs">${cellPriority(t)}</td>
      <td class="py-1.5 px-2 align-top text-xs whitespace-nowrap">${cellDue(t)}</td>
      <td class="py-1.5 px-2 align-top text-xs whitespace-nowrap">${cellDeadline(t)}</td>
      <td class="py-1.5 px-2 align-top text-xs text-td-muted whitespace-nowrap">${formatDuration(t.durationMinutes) || '—'}</td>
    </tr>
  `).join('');

  list.innerHTML = `
    <div class="overflow-x-auto">
      <table class="w-full border-collapse text-sm">
        <thead class="border-b border-td-border">${head}</thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;

  // The table is a fixed order (it follows the sort), so drag reordering
  // is not offered here.
  bindTaskEvents(false);
}
